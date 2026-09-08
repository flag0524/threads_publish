'use strict';
const path = require('path');
require('dotenv').config();

const ROOT = __dirname;

function num(key, def) {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key}는 숫자여야 합니다: "${v}"`);
  return n;
}

function list(key, def) {
  const v = process.env[key];
  if (v === undefined || v.trim() === '') return def;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

const config = {
  root: ROOT,
  paths: {
    content: path.join(ROOT, 'content'),
    queue: path.join(ROOT, 'content', 'queue'),
    drafts: path.join(ROOT, 'content', 'drafts'),
    published: path.join(ROOT, 'content', 'published'),
    failed: path.join(ROOT, 'content', 'failed'),
    data: path.join(ROOT, 'data'),
    token: path.join(ROOT, 'data', 'token.json'),
    history: path.join(ROOT, 'data', 'history.jsonl'),
    lock: path.join(ROOT, 'data', '.lock'),
    logs: path.join(ROOT, 'logs'),
  },

  appId: process.env.THREADS_APP_ID,
  appSecret: process.env.THREADS_APP_SECRET,
  shortLivedToken: process.env.THREADS_SHORT_LIVED_TOKEN,
  // OAuth 코드 교환용. Meta 앱에 등록된 리디렉트 URI와 문자 그대로 같아야 한다.
  redirectUri: process.env.THREADS_REDIRECT_URI,

  apiVersion: process.env.THREADS_API_VERSION || 'v1.0',
  postCron: process.env.POST_CRON || '0 9 * * *',
  tz: process.env.TZ || 'Asia/Seoul',

  maxPostsPerDay: num('MAX_POSTS_PER_DAY', 1),
  replyDelayMs: num('REPLY_DELAY_MS', 5000),
  publishRetry: num('PUBLISH_RETRY', 3),
  tokenRefreshBeforeDays: num('TOKEN_REFRESH_BEFORE_DAYS', 7),

  sources: list('SOURCES', ['queue']),
  bannedWords: list('BANNED_WORDS', []),

  // 발행 계정 가드. 토큰의 username이 이 값과 다르면 발행을 거부한다.
  // 빈 값이면 검사하지 않는다. 앞의 @는 있어도 되고 없어도 된다.
  expectedUsername: (process.env.EXPECTED_THREADS_USERNAME || '').trim().replace(/^@/, ''),

  // 고정 상수
  maxTextLength: 500,
  containerPollIntervalMs: 1000,
  containerPollMaxTries: 10,
  httpTimeoutMs: 15000,
  logRetentionDays: 30,
};

/**
 * 필수 키를 검사한다. 누락된 키 이름을 전부 모아서 알려준다.
 * @param {string[]} required 검사할 키 목록
 */
function assertRequired(required) {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(
      `[설정 오류] .env에 다음 키가 없습니다: ${missing.join(', ')}\n` +
        `.env.example을 복사해 .env를 만들고 값을 채우세요.`
    );
    process.exit(1);
  }
}

config.assertRequired = assertRequired;
config.REQUIRED_RUN = ['THREADS_APP_ID', 'THREADS_APP_SECRET'];
config.REQUIRED_SETUP = ['THREADS_APP_ID', 'THREADS_APP_SECRET', 'THREADS_SHORT_LIVED_TOKEN'];
// --setup --code <인증코드> 로 실행할 때. 단기 토큰 대신 리디렉트 URI가 필요하다.
config.REQUIRED_SETUP_CODE = ['THREADS_APP_ID', 'THREADS_APP_SECRET', 'THREADS_REDIRECT_URI'];

module.exports = config;
