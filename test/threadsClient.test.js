'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { ThreadsClient, normalizeError } = require('../core/threadsClient');

/** axios 어댑터를 갈아끼워 실제 네트워크 없이 파라미터를 검사한다. */
function withAdapter(client, handler) {
  const calls = [];
  client.http.defaults.adapter = async (cfg) => {
    calls.push(cfg);
    const out = handler(cfg);
    if (out && out.__error) {
      const err = new Error('mock');
      err.response = { status: out.status, data: out.data };
      throw err;
    }
    return { data: out, status: 200, statusText: 'OK', headers: {}, config: cfg };
  };
  return calls;
}

test('createTextContainer: 댓글은 reply_to_id를 쓴다 (reply_to_thread_key 아님)', async () => {
  const c = new ThreadsClient({ accessToken: 'T', userId: '123', apiVersion: 'v1.0' });
  const calls = withAdapter(c, () => ({ id: 'c1' }));

  await c.createTextContainer({ text: '댓글', replyToId: 'main-1' });

  const p = calls[0].params;
  assert.equal(p.reply_to_id, 'main-1');
  assert.equal(p.reply_to_thread_key, undefined);
  assert.equal(p.media_type, 'TEXT');
  assert.equal(p.text, '댓글');
  assert.equal(calls[0].url, '/v1.0/123/threads');
});

test('createTextContainer: 메인 게시물에는 reply_to_id를 넣지 않는다', async () => {
  const c = new ThreadsClient({ accessToken: 'T', userId: '123' });
  const calls = withAdapter(c, () => ({ id: 'c1' }));
  await c.createTextContainer({ text: '메인' });
  assert.equal(calls[0].params.reply_to_id, undefined);
});

test('exchangeAuthCode: authorization_code 폼 바디로 보내고 code 끝의 #_를 뗀다', async () => {
  const c = new ThreadsClient({});
  const calls = withAdapter(c, () => ({ access_token: 'short-1', user_id: '123' }));

  const res = await c.exchangeAuthCode({
    code: 'AUTHCODE#_',
    appId: 'app',
    appSecret: 'sec',
    redirectUri: 'https://example.com/cb',
  });

  assert.equal(res.access_token, 'short-1');
  assert.equal(calls[0].url, '/oauth/access_token');
  const body = new URLSearchParams(String(calls[0].data));
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'AUTHCODE');
  assert.equal(body.get('redirect_uri'), 'https://example.com/cb');
  assert.equal(body.get('client_id'), 'app');
  assert.equal(body.get('client_secret'), 'sec');
  // 아직 토큰이 없으므로 access_token 파라미터가 붙으면 안 된다
  assert.equal((calls[0].params || {}).access_token, undefined);
});

test('publish: creation_id 파라미터로 발행한다', async () => {
  const c = new ThreadsClient({ accessToken: 'T', userId: '123' });
  const calls = withAdapter(c, () => ({ id: 'published-1' }));
  const id = await c.publish('c1');
  assert.equal(id, 'published-1');
  assert.equal(calls[0].params.creation_id, 'c1');
  assert.equal(calls[0].url, '/v1.0/123/threads_publish');
});

test('waitUntilFinished: IN_PROGRESS 후 FINISHED가 되면 통과', async () => {
  const c = new ThreadsClient({ accessToken: 'T', userId: '123' });
  let n = 0;
  withAdapter(c, () => ({ status: ++n < 2 ? 'IN_PROGRESS' : 'FINISHED' }));
  assert.equal(await c.waitUntilFinished('c1'), 'FINISHED');
});

test('waitUntilFinished: ERROR면 재시도 불가 오류', async () => {
  const c = new ThreadsClient({ accessToken: 'T', userId: '123' });
  withAdapter(c, () => ({ status: 'ERROR', error_message: '본문 거부' }));
  await assert.rejects(() => c.waitUntilFinished('c1'), (e) => {
    assert.match(e.message, /컨테이너 ERROR: 본문 거부/);
    assert.equal(e.isRetryable, false);
    return true;
  });
});

test('오류 정규화: 코드 190은 인증 오류, 재시도 안 함', () => {
  const err = { response: { status: 400, data: { error: { code: 190, message: '토큰 무효' } } } };
  const e = normalizeError(err);
  assert.equal(e.isAuthError, true);
  assert.equal(e.isRetryable, false);
});

test('오류 정규화: 429는 재시도 대상', () => {
  const e = normalizeError({ response: { status: 429, data: { error: { code: 4, message: 'rate limit' } } } });
  assert.equal(e.isRetryable, true);
  assert.equal(e.isAuthError, false);
});

test('오류 정규화: 5xx는 재시도 대상', () => {
  const e = normalizeError({ response: { status: 503, data: {} } });
  assert.equal(e.isRetryable, true);
});

test('오류 정규화: 발행 직후 "does not exist"(code 100)는 재시도 대상', () => {
  const e = normalizeError({
    response: { status: 400, data: { error: { code: 100, message: 'The requested resource does not exist' } } },
  });
  assert.equal(e.isRetryable, true);
  assert.equal(e.isAuthError, false);
});

test('오류 정규화: code 100 시크릿 오류는 재시도 대상 아님', () => {
  const e = normalizeError({
    response: { status: 400, data: { error: { code: 100, message: 'Invalid parameter' } } },
  });
  assert.equal(e.isRetryable, false);
});

test('오류 정규화: 403은 인증 오류', () => {
  const e = normalizeError({ response: { status: 403, data: {} } });
  assert.equal(e.isAuthError, true);
  assert.equal(e.isRetryable, false);
});

test('오류 정규화: 네트워크 오류는 재시도 대상', () => {
  const e = normalizeError({ message: 'ECONNRESET' });
  assert.equal(e.isRetryable, true);
  assert.match(e.message, /네트워크 오류/);
});

test('logger.mask: 토큰과 시크릿을 가린다', () => {
  const logger = require('../core/logger');
  assert.match(logger.mask('GET /me?access_token=ABC123&x=1'), /access_token=\*\*\*\*/);
  assert.ok(!logger.mask('client_secret=SECRETVALUE').includes('SECRETVALUE'));
  assert.ok(!logger.mask('{"accessToken":"LONGTOKEN"}').includes('LONGTOKEN'));
});
