'use strict';
const cron = require('node-cron');
const config = require('./config');
const logger = require('./core/logger');
const notify = require('./core/notify');
const token = require('./core/token');
const queueSource = require('./sources/queueSource');
const { run } = require('./index');

config.assertRequired(config.REQUIRED_RUN);
logger.cleanupOldLogs();

if (!cron.validate(config.postCron)) {
  logger.error(`POST_CRON이 올바른 cron 식이 아닙니다: "${config.postCron}"`);
  process.exit(1);
}

logger.info(`스케줄러 시작 — POST_CRON="${config.postCron}" TZ=${config.tz} SOURCES=${config.sources.join(',')}`);

cron.schedule(
  config.postCron,
  async () => {
    try {
      await run({ mode: 'scheduled' });
    } catch (err) {
      logger.error(`스케줄 실행 실패: ${err.message}`);
    }
  },
  { timezone: config.tz }
);

/**
 * 주 1회 생존 신호.
 * 발행 실패 알림은 run()이 돌아야만 울린다. 스케줄러가 죽으면 실패조차 없어서
 * 알림도 영원히 안 온다 — 그래서 "살아 있음"을 따로 보낸다.
 * 이 알림이 안 오면 스케줄러가 죽은 것이다 (ADR-012).
 */
async function sendHeartbeat() {
  const s = token.status();
  const queued = queueSource.listFiles().length;
  const line = s.exists
    ? `@${s.username} 토큰 잔여 ${s.daysLeft}일, 큐 ${queued}건`
    : `토큰 없음 — --setup 필요, 큐 ${queued}건`;
  logger.info(`생존 신호 — ${line}`);
  await notify.send(`[Threads 자동발행] 생존 신호 — ${line}`);
}

if (cron.validate(config.heartbeatCron)) {
  cron.schedule(config.heartbeatCron, sendHeartbeat, { timezone: config.tz });
  logger.info(`생존 신호 스케줄 — HEARTBEAT_CRON="${config.heartbeatCron}"`);
} else {
  logger.error(`HEARTBEAT_CRON이 올바른 cron 식이 아닙니다: "${config.heartbeatCron}" — 생존 신호를 끕니다`);
}

// 3차(RSS)를 켜면 여기에 폴링 스케줄을 추가한다.
// if (config.sources.includes('rss')) cron.schedule(process.env.RSS_POLL_CRON || '0 * * * *', rssSource.poll, { timezone: config.tz });

process.on('SIGINT', () => {
  logger.info('스케줄러 종료');
  process.exit(0);
});
