'use strict';
const cron = require('node-cron');
const config = require('./config');
const logger = require('./core/logger');
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

// 3차(RSS)를 켜면 여기에 폴링 스케줄을 추가한다.
// if (config.sources.includes('rss')) cron.schedule(process.env.RSS_POLL_CRON || '0 * * * *', rssSource.poll, { timezone: config.tz });

process.on('SIGINT', () => {
  logger.info('스케줄러 종료');
  process.exit(0);
});
