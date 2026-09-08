'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const minLevel = LEVELS[(process.env.LOG_LEVEL || 'INFO').toUpperCase()] || LEVELS.INFO;

// 토큰·시크릿은 어떤 경로로도 로그에 남기지 않는다.
const SECRET_PATTERNS = [
  /(access_token=)[^&\s"']+/gi,
  /(client_secret=)[^&\s"']+/gi,
  /("accessToken"\s*:\s*")[^"]+/gi,
  /(THREADS_APP_SECRET=)\S+/gi,
];

function mask(input) {
  let s = typeof input === 'string' ? input : safeStringify(input);
  for (const re of SECRET_PATTERNS) s = s.replace(re, '$1****');
  return s;
}

function safeStringify(v) {
  try {
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function logFilePath(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return path.join(config.paths.logs, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`);
}

function write(level, args) {
  if (LEVELS[level] < minLevel) return;
  const line = `[${stamp()}] [${level}] ${args.map(mask).join(' ')}`;
  if (level === 'ERROR' || level === 'WARN') console.error(line);
  else console.log(line);
  try {
    fs.mkdirSync(config.paths.logs, { recursive: true });
    fs.appendFileSync(logFilePath(), line + '\n', 'utf8');
  } catch {
    // 파일 로그 실패가 발행을 막아서는 안 된다.
  }
}

/** 기동 시 오래된 로그 파일을 지운다. */
function cleanupOldLogs(retentionDays = config.logRetentionDays) {
  let removed = 0;
  try {
    const cutoff = Date.now() - retentionDays * 86400000;
    for (const f of fs.readdirSync(config.paths.logs)) {
      if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
      const p = path.join(config.paths.logs, f);
      if (fs.statSync(p).mtimeMs < cutoff) {
        fs.unlinkSync(p);
        removed++;
      }
    }
  } catch {
    // 로그 폴더가 없으면 지울 것도 없다.
  }
  return removed;
}

module.exports = {
  debug: (...a) => write('DEBUG', a),
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
  mask,
  cleanupOldLogs,
};
