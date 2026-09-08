'use strict';
const fs = require('fs');
const config = require('../config');
const logger = require('./logger');
const notify = require('./notify');
const { ThreadsClient } = require('./threadsClient');

const DAY = 86400000;

function read() {
  if (!fs.existsSync(config.paths.token)) return null;
  return JSON.parse(fs.readFileSync(config.paths.token, 'utf8'));
}

function write(t) {
  fs.mkdirSync(config.paths.data, { recursive: true });
  fs.writeFileSync(config.paths.token, JSON.stringify(t, null, 2), 'utf8');
}

/** 만료까지 남은 일수 (소수점 포함). 토큰이 없으면 null. */
function daysLeft(token, now = Date.now()) {
  if (!token || !token.expiresAt) return null;
  return (new Date(token.expiresAt).getTime() - now) / DAY;
}

/** 갱신해야 하는가? 발급 24시간 이내에는 API 제약으로 갱신하지 않는다. */
function shouldRefresh(token, now = Date.now(), beforeDays = config.tokenRefreshBeforeDays) {
  const left = daysLeft(token, now);
  if (left === null) return false;
  if (left >= beforeDays) return false;
  const issued = new Date(token.issuedAt || 0).getTime();
  const last = token.lastRefreshAt ? new Date(token.lastRefreshAt).getTime() : issued;
  if (now - last < DAY) return false; // 24시간 이내 재갱신 불가
  return true;
}

/**
 * 단기 토큰을 장기 토큰으로 교환하고 저장한다.
 * code를 주면 인증 코드 → 단기 토큰 단계를 먼저 거치고, 없으면 .env의 단기 토큰을 쓴다.
 */
async function setup({ code } = {}) {
  const client = new ThreadsClient({});
  let shortToken;

  if (code) {
    config.assertRequired(config.REQUIRED_SETUP_CODE);
    const auth = await client.exchangeAuthCode({
      code,
      appId: config.appId,
      appSecret: config.appSecret,
      redirectUri: config.redirectUri,
    });
    if (!auth.access_token) throw new Error('인증 코드 교환 응답에 access_token이 없습니다');
    logger.info('인증 코드 → 단기 토큰 교환 완료');
    shortToken = auth.access_token;
  } else {
    config.assertRequired(config.REQUIRED_SETUP);
    shortToken = config.shortLivedToken;
  }

  const res = await client.exchangeLongLivedToken(shortToken, config.appSecret);
  if (!res.access_token) throw new Error('장기 토큰 교환 응답에 access_token이 없습니다');

  const now = Date.now();
  client.accessToken = res.access_token;
  const me = await client.getMe();

  const token = {
    accessToken: res.access_token,
    userId: me.id,
    username: me.username,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (res.expires_in || 60 * DAY / 1000) * 1000).toISOString(),
    lastRefreshAt: null,
  };
  write(token);
  logger.info(`토큰 저장 완료 — @${me.username} (id ${me.id}), 만료 ${token.expiresAt}`);
  if (config.expectedUsername) {
    if ((me.username || '').toLowerCase() !== config.expectedUsername.toLowerCase()) {
      logger.error(
        `계정 불일치 — 발급된 토큰은 @${me.username} 인데 EXPECTED_THREADS_USERNAME은 @${config.expectedUsername} 입니다. ` +
          `이 상태로는 발행이 거부됩니다. data/token.json을 지우고 @${config.expectedUsername}로 다시 발급하세요.`
      );
    } else {
      logger.info(`계정 확인 완료 — @${config.expectedUsername}`);
    }
  }
  logger.warn('이제 .env의 THREADS_SHORT_LIVED_TOKEN 줄을 지우세요.');
  return token;
}

/**
 * 토큰의 계정이 EXPECTED_THREADS_USERNAME과 일치하는지 확인한다.
 * 다른 계정에 잘못 발행하는 사고를 막는 안전장치.
 */
function assertExpectedAccount(token, expected = config.expectedUsername) {
  if (!expected) return;
  const actual = (token.username || '').replace(/^@/, '');
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    const e = new Error(
      `발행 계정 불일치: 토큰은 @${actual || '?'} 인데 EXPECTED_THREADS_USERNAME은 @${expected} 입니다. ` +
        `발행을 중단합니다. 계정을 바꾸려면 data/token.json을 지우고 @${expected}로 --setup을 다시 실행하세요.`
    );
    e.isAuthError = true;
    throw e;
  }
}

/**
 * 유효한 토큰을 반환한다. 만료가 가까우면 갱신을 시도한다.
 * 갱신 실패는 발행을 막지 않는다 (기존 토큰이 아직 유효하므로).
 */
async function ensureValid() {
  const token = read();
  if (!token) {
    const e = new Error('data/token.json이 없습니다. `node index.js --setup`을 먼저 실행하세요.');
    e.isAuthError = true;
    throw e;
  }
  assertExpectedAccount(token);
  const left = daysLeft(token);
  if (left !== null && left <= 0) {
    const e = new Error('토큰이 만료되었습니다. `node index.js --setup`을 다시 실행하세요.');
    e.isAuthError = true;
    throw e;
  }

  if (shouldRefresh(token)) {
    try {
      const client = new ThreadsClient({ accessToken: token.accessToken, userId: token.userId });
      const res = await client.refreshLongLivedToken();
      const now = Date.now();
      token.accessToken = res.access_token || token.accessToken;
      token.expiresAt = new Date(now + (res.expires_in || 60 * DAY / 1000) * 1000).toISOString();
      token.lastRefreshAt = new Date(now).toISOString();
      write(token);
      logger.info(`토큰 갱신 완료 — 새 만료 ${token.expiresAt}`);
    } catch (err) {
      const msg = `토큰 갱신 실패: ${err.message}`;
      if (left !== null && left < 2) {
        logger.error(`${msg} (잔여 ${left.toFixed(1)}일 — 조치 필요)`);
        // 무인 운영에서 조용히 죽는 유일한 경로라 알림을 보낸다.
        await notify.send(`[Threads 자동발행] ${msg}\n잔여 ${left.toFixed(1)}일 — \`node index.js --setup\` 필요`);
      } else logger.warn(msg);
    }
  }
  return token;
}

/** --token-status 출력용. */
function status() {
  const token = read();
  if (!token) return { exists: false };
  const left = daysLeft(token);
  return {
    exists: true,
    username: token.username,
    userId: token.userId,
    expiresAt: token.expiresAt,
    daysLeft: left === null ? null : Number(left.toFixed(1)),
    lastRefreshAt: token.lastRefreshAt,
    needsRefresh: shouldRefresh(token),
  };
}

module.exports = { setup, ensureValid, status, read, write, daysLeft, shouldRefresh, assertExpectedAccount };
