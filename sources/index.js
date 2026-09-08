'use strict';
const config = require('../config');
const logger = require('../core/logger');

const available = {
  queue: require('./queueSource'),
  // 2차: llm, 3차: rss — 파일을 추가하고 여기에 등록하면 된다.
};

function activeSources() {
  return config.sources
    .map((n) => {
      const s = available[n];
      if (!s) logger.warn(`알 수 없는 소스 "${n}" — 건너뜁니다`);
      return s;
    })
    .filter(Boolean);
}

/** SOURCES 순서대로 fetchNext를 호출해 첫 번째 non-null 항목을 반환한다. */
async function fetchNext(ctx = {}) {
  for (const s of activeSources()) {
    const item = await s.fetchNext(ctx);
    if (item) return { item, source: s };
  }
  return null;
}

module.exports = { available, activeSources, fetchNext };
