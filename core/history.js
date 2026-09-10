'use strict';
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');

function hashText(text) {
  return 'sha256:' + crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function readAll(file = config.paths.history) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function append(entry, file = config.paths.history) {
  fs.mkdirSync(require('path').dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
}

/** 같은 id 또는 같은 textHash가 success로 있으면 중복이다. */
function isDuplicate(item, file = config.paths.history) {
  const h = hashText(item.text);
  return readAll(file).some(
    (e) => e.status === 'success' && (e.id === item.id || e.textHash === h)
  );
}

/**
 * KST 기준 오늘 발행 건수.
 * 상태 이름이 아니라 mainId 유무로 센다 — partial도 메인 글은 이미 올라간 상태라
 * 하루 상한에 포함해야 한다 (ADR-015).
 */
function countToday(file = config.paths.history, now = new Date()) {
  const kst = (d) => new Date(new Date(d).getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const today = kst(now);
  return readAll(file).filter((e) => e.mainId && kst(e.ts) === today).length;
}

module.exports = { hashText, readAll, append, isDuplicate, countToday };
