'use strict';
const fs = require('fs');
const config = require('./config');
const logger = require('./core/logger');
const history = require('./core/history');
const token = require('./core/token');
const publisher = require('./core/publisher');
const sources = require('./sources');

// ---------- 락 ----------
function acquireLock() {
  const p = config.paths.lock;
  fs.mkdirSync(config.paths.data, { recursive: true });
  if (fs.existsSync(p)) {
    let info = {};
    try {
      info = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* 깨진 락은 stale로 본다 */ }
    if (info.pid && isAlive(info.pid)) {
      logger.warn(`이미 실행 중입니다 (pid ${info.pid}, 시작 ${info.startedAt}) — 이번 실행은 건너뜁니다`);
      return false;
    }
    logger.warn(`stale 락 삭제 (pid ${info.pid ?? '?'})`);
    fs.unlinkSync(p);
  }
  fs.writeFileSync(p, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
  return true;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 남의 프로세스지만 살아 있음
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(config.paths.lock);
  } catch { /* 이미 없으면 그만 */ }
}

// ---------- 실행 ----------
async function run({ mode = 'manual', dryRun = false } = {}) {
  logger.cleanupOldLogs();
  if (!dryRun) config.assertRequired(config.REQUIRED_RUN);
  if (!acquireLock()) return { skipped: 'locked' };

  try {
    if (!dryRun) {
      const todayCount = history.countToday();
      if (todayCount >= config.maxPostsPerDay) {
        logger.info(`오늘 이미 ${todayCount}건 발행 — 상한 ${config.maxPostsPerDay} 도달, 종료`);
        return { skipped: 'daily-cap' };
      }
    }

    const picked = await sources.fetchNext({});
    if (!picked) {
      logger.info('발행할 항목이 없습니다 (큐 비어 있음 또는 publishAt이 전부 미래)');
      return { skipped: 'empty' };
    }

    const { item, source } = picked;
    logger.info(`[${mode}${dryRun ? '/dry-run' : ''}] 선택: ${item.id} (source=${item.source})`);

    let result;
    try {
      result = await publisher.publishThread(item, { dryRun });
    } catch (err) {
      if (!dryRun) await source.onFailed(item, err);
      logger.error(`발행 실패 [${item.id}]: ${err.message}`);
      if (err.isAuthError) logger.error('토큰 문제입니다. `node index.js --setup`을 다시 실행하세요.');
      throw err;
    }

    if (result.status === 'success' && !dryRun) await source.onPublished(item, result);
    if (result.status === 'skipped-duplicate' && !dryRun) await source.onPublished(item, result);
    // skipped-validation은 고칠 수 있도록 큐에 남긴다 (TDD 9장)

    logger.info(`결과: ${result.status}${result.mainId ? ` — https://www.threads.net/@${(token.read() || {}).username || ''}/post/${result.mainId}` : ''}`);
    return result;
  } finally {
    releaseLock();
  }
}

// ---------- CLI ----------
async function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const valueOf = (f) => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] : undefined;
  };

  try {
    if (has('--setup')) {
      await token.setup({ code: valueOf('--code') });
      return;
    }
    if (has('--token-status')) {
      const s = token.status();
      if (!s.exists) {
        console.log('토큰 없음 — `node index.js --setup`을 실행하세요.');
        process.exitCode = 1;
        return;
      }
      console.log(
        `@${s.username} (id ${s.userId})\n` +
          `만료: ${s.expiresAt} (잔여 ${s.daysLeft}일)\n` +
          `마지막 갱신: ${s.lastRefreshAt || '없음'}\n` +
          `갱신 필요: ${s.needsRefresh ? '예' : '아니오'}`
      );
      return;
    }
    if (has('--dry-run')) {
      await run({ mode: 'manual', dryRun: true });
      return;
    }
    if (has('--now')) {
      await run({ mode: 'manual', dryRun: false });
      return;
    }

    console.log(
      `사용법:\n` +
        `  node index.js --setup          .env의 단기 토큰 → 장기 토큰 교환 후 저장\n` +
        `  node index.js --setup --code <인증코드>\n` +
        `                                 OAuth 인증 코드 → 단기 → 장기 토큰 교환 후 저장\n` +
        `  node index.js --token-status   토큰 잔여 기간 확인\n` +
        `  node index.js --dry-run        API 호출 없이 파이프라인 점검\n` +
        `  node index.js --now            지금 1건 발행\n` +
        `  node scheduler.js              스케줄러 상시 실행 (${config.postCron} ${config.tz})`
    );
  } catch (err) {
    logger.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { run, acquireLock, releaseLock, isAlive };
