'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../core/logger');

/** 파일 앞머리의 BOM을 제거한다. JSON.parse와 front-matter 매칭이 BOM에 걸린다. */
const stripBom = (s) => s.replace(/^﻿/, '');

/**
 * Markdown front-matter 형식을 파싱한다.
 * 외부 라이브러리를 쓰지 않고 단순 `key: value`만 지원한다 (TDD 6.1).
 * 본문과 댓글은 `---` 줄로 구분한다.
 */
function parseMarkdown(raw) {
  let body = stripBom(raw);
  const meta = {};

  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/);
      if (m) meta[m[1]] = m[2].trim();
    }
    body = body.slice(fm[0].length);
  }

  const blocks = body
    .split(/\r?\n---\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  // front-matter에서 뽑아 쓰는 키는 link·publishAt 뿐이다.
  // meta를 통째로 펼치면 `text:` 같은 키가 파싱된 본문을 덮어써서
  // 쓴 글과 다른 글이 올라갈 수 있다.
  return {
    text: blocks[0] || '',
    replies: blocks.slice(1),
    link: meta.link,
    publishAt: meta.publishAt,
  };
}

function parseFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const name = path.basename(filePath);
  let parsed;
  if (name.toLowerCase().endsWith('.json')) {
    parsed = JSON.parse(stripBom(raw));
  } else {
    parsed = parseMarkdown(raw);
  }
  return {
    id: name,
    source: 'queue',
    text: parsed.text,
    replies: Array.isArray(parsed.replies) ? parsed.replies : [],
    link: parsed.link || undefined,
    publishAt: parsed.publishAt || undefined,
    meta: parsed.meta || undefined,
    _path: filePath,
  };
}

/** 큐 폴더의 발행 대상 파일명을 이름 오름차순으로 반환한다. */
function listFiles(dir = config.paths.queue) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(json|md)$/i.test(f))
    .sort();
}

/**
 * 발행할 1건을 반환한다. publishAt이 미래인 파일은 건너뛰고 다음 파일을 본다.
 * 없으면 null.
 */
async function fetchNext(ctx = {}) {
  const dir = ctx.queueDir || config.paths.queue;
  const now = ctx.now ? new Date(ctx.now) : new Date();

  for (const f of listFiles(dir)) {
    const p = path.join(dir, f);
    let item;
    try {
      item = parseFile(p);
    } catch (err) {
      logger.warn(`큐 파일 파싱 실패, 건너뜀: ${f} — ${err.message}`);
      continue;
    }
    if (item.publishAt) {
      const at = new Date(item.publishAt);
      if (!Number.isNaN(at.getTime()) && at > now) {
        logger.debug(`${f}: publishAt ${item.publishAt}이 아직 미래 — 건너뜀`);
        continue;
      }
    }
    return item;
  }
  return null;
}

function move(item, destDir) {
  if (!item._path || !fs.existsSync(item._path)) return null;
  fs.mkdirSync(destDir, { recursive: true });
  let dest = path.join(destDir, path.basename(item._path));
  if (fs.existsSync(dest)) {
    const ext = path.extname(dest);
    dest = dest.slice(0, -ext.length) + `_${Date.now()}` + ext;
  }
  fs.renameSync(item._path, dest);
  return dest;
}

module.exports = {
  name: 'queue',
  fetchNext,
  async onPublished(item) {
    const dest = move(item, config.paths.published);
    if (dest) logger.info(`발행 완료 → ${path.relative(config.root, dest)}`);
  },
  async onFailed(item) {
    const dest = move(item, config.paths.failed);
    if (dest) logger.warn(`발행 실패 → ${path.relative(config.root, dest)}`);
  },
  // 테스트·재사용용
  parseMarkdown,
  parseFile,
  listFiles,
};
