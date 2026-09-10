'use strict';
const config = require('../config');
const logger = require('./logger');
const history = require('./history');
const validator = require('./validator');
const token = require('./token');
const { ThreadsClient } = require('./threadsClient');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 재시도 가능한 오류에 한해 2s → 4s → 8s 백오프로 재시도한다. */
async function withRetry(label, fn, retries = config.publishRetry) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err.isAuthError) throw err;          // 토큰 문제는 재시도해도 소용없다
      if (!err.isRetryable || attempt === retries) throw err;
      const wait = 2000 * 2 ** (attempt - 1);
      logger.warn(`${label} 실패(${attempt}/${retries}): ${err.message} — ${wait / 1000}s 후 재시도`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** 컨테이너 생성 → FINISHED 대기 → 발행. 세 단계를 한 묶음으로 재시도한다. */
async function postOne(client, { text, replyToId, linkAttachment }, label) {
  return withRetry(label, async () => {
    const containerId = await client.createTextContainer({ text, replyToId, linkAttachment });
    await client.waitUntilFinished(containerId);
    return client.publish(containerId);
  });
}

/**
 * 메인 게시물 + 연쇄 댓글을 발행한다.
 * @returns {{status:string, mainId:string|null, replyIds:string[], error:string|null}}
 */
async function publishThread(item, { dryRun = false, client: injectedClient = null } = {}) {
  const started = Date.now();
  const textHash = history.hashText(item.text);
  const base = { ts: new Date().toISOString(), id: item.id, source: item.source, textHash };

  const v = validator.validate(item);
  if (!v.ok) {
    logger.warn(`검증 실패 [${item.id}]: ${v.errors.join(' / ')}`);
    const entry = { ...base, mainId: null, replyIds: [], status: 'skipped-validation', error: v.errors.join('; '), durationMs: Date.now() - started };
    if (!dryRun) history.append(entry);
    return entry;
  }

  if (history.isDuplicate(item)) {
    logger.warn(`중복 [${item.id}] — 같은 id 또는 본문이 이미 발행됨`);
    const entry = { ...base, mainId: null, replyIds: [], status: 'skipped-duplicate', error: null, durationMs: Date.now() - started };
    if (!dryRun) history.append(entry);
    return entry;
  }

  if (dryRun) {
    logger.info(`[DRY-RUN] 발행하지 않고 종료 — 메인 ${item.text.length}자, 댓글 ${item.replies.length}개`);
    item.replies.forEach((r, i) => logger.info(`[DRY-RUN]   댓글 ${i + 1}: ${r.length}자`));
    if (item.link) logger.info(`[DRY-RUN]   link_attachment: ${item.link}`);
    return { ...base, mainId: null, replyIds: [], status: 'dry-run', error: null, durationMs: Date.now() - started };
  }

  // injectedClient는 테스트에서 가짜 클라이언트를 넣기 위한 자리다.
  // 실제 실행 경로에서는 항상 null이라 토큰 검사를 거친다.
  let client = injectedClient;
  if (!client) {
    const t = await token.ensureValid();
    client = new ThreadsClient({ accessToken: t.accessToken, userId: t.userId });
  }

  const replyIds = [];
  let mainId = null;
  try {
    mainId = await postOne(client, { text: item.text, linkAttachment: item.link }, '메인 게시물');
    logger.info(`메인 게시물 발행됨 — id ${mainId}`);

    for (let i = 0; i < item.replies.length; i++) {
      await sleep(config.replyDelayMs);
      const parent = replyIds.length ? replyIds[replyIds.length - 1] : mainId;
      const id = await postOne(client, { text: item.replies[i], replyToId: parent }, `댓글 ${i + 1}`);
      replyIds.push(id);
      logger.info(`댓글 ${i + 1}/${item.replies.length} 발행됨 — id ${id}`);
    }

    const entry = { ...base, mainId, replyIds, status: 'success', error: null, durationMs: Date.now() - started };
    history.append(entry);
    return entry;
  } catch (err) {
    const partial = mainId !== null;
    const entry = {
      ...base,
      mainId,
      replyIds,
      status: partial ? 'partial' : 'failed',
      publishedReplies: replyIds.length,
      error: err.message,
      durationMs: Date.now() - started,
    };
    history.append(entry);
    if (partial) {
      logger.error(
        `댓글 중간 실패 — 메인과 댓글 ${replyIds.length}개는 이미 올라갔습니다. ` +
          `재발행 시 파일에서 그 ${replyIds.length}개를 지우고 큐에 다시 넣으세요.`
      );
    }
    throw Object.assign(err, { entry });
  }
}

module.exports = { publishThread, withRetry, postOne };
