'use strict';
// publisher의 조립 라인(메인 → 연쇄 댓글 → partial → 재시도)을 네트워크 없이 검증한다
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config');
const publisher = require('../core/publisher');

// 이력은 임시 파일로, 댓글 간 대기는 0으로 — 실제 data/를 건드리지 않는다.
config.paths.history = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pub-')), 'history.jsonl');
config.replyDelayMs = 0;

/**
 * 가짜 ThreadsClient. 호출 순서와 파라미터를 그대로 기록한다.
 * failOnContainer번째 컨테이너 생성에서 재시도 불가 오류를 던진다.
 */
function fakeClient({ failOnContainer = null } = {}) {
  let n = 0;
  const calls = [];
  return {
    calls,
    async createTextContainer(params) {
      n += 1;
      calls.push({ step: 'container', text: params.text, replyToId: params.replyToId });
      if (failOnContainer === n) {
        const e = new Error('컨테이너 생성 실패');
        e.isRetryable = false;
        throw e;
      }
      return `c${n}`;
    },
    async waitUntilFinished(id) {
      calls.push({ step: 'wait', id });
      return 'FINISHED';
    },
    async publish(id) {
      calls.push({ step: 'publish', id });
      return `p${id.slice(1)}`;
    },
  };
}

// 본문 해시가 겹치면 isDuplicate에 걸려 발행이 건너뛰어진다 — 테스트마다 다른 본문을 쓴다.
let seq = 0;
const item = (over = {}) => {
  seq += 1;
  return { id: `t${seq}.json`, source: 'queue', text: `메인 ${seq}`, replies: [`댓1-${seq}`, `댓2-${seq}`], ...over };
};

test('publishThread: 메인과 댓글을 모두 발행하면 success', async () => {
  const client = fakeClient();
  const r = await publisher.publishThread(item(), { client });

  assert.equal(r.status, 'success');
  assert.equal(r.mainId, 'p1');
  assert.deepEqual(r.replyIds, ['p2', 'p3']);
});

test('publishThread: 각 댓글의 reply_to_id는 직전 게시물 id다 (사슬)', async () => {
  const client = fakeClient();
  await publisher.publishThread(item(), { client });

  const containers = client.calls.filter((c) => c.step === 'container');
  assert.equal(containers.length, 3);
  assert.equal(containers[0].replyToId, undefined, '메인에는 reply_to_id가 없다');
  assert.equal(containers[1].replyToId, 'p1', '첫 댓글은 메인에 달린다');
  assert.equal(containers[2].replyToId, 'p2', '둘째 댓글은 첫 댓글에 달린다');
});

test('publishThread: 한 건은 컨테이너 → 폴링 → 발행 순서로 처리된다', async () => {
  const client = fakeClient();
  await publisher.publishThread(item({ replies: [] }), { client });

  assert.deepEqual(client.calls.map((c) => c.step), ['container', 'wait', 'publish']);
});

test('publishThread: 댓글 중간 실패는 partial이고 올라간 개수를 남긴다', async () => {
  const client = fakeClient({ failOnContainer: 2 }); // 메인은 성공, 첫 댓글에서 실패
  await assert.rejects(
    () => publisher.publishThread(item(), { client }),
    (err) => {
      assert.equal(err.entry.status, 'partial');
      assert.equal(err.entry.mainId, 'p1', '메인은 이미 올라간 상태');
      assert.equal(err.entry.publishedReplies, 0);
      return true;
    }
  );
});

test('publishThread: 500자를 넘으면 발행하지 않고 skipped-validation', async () => {
  const client = fakeClient();
  const r = await publisher.publishThread(item({ text: 'ㄱ'.repeat(501) }), { client });

  assert.equal(r.status, 'skipped-validation');
  assert.equal(client.calls.length, 0, 'API를 한 번도 부르지 않는다');
});

test('withRetry: 토큰 오류는 재시도하지 않고 즉시 중단한다', async () => {
  let tries = 0;
  await assert.rejects(() =>
    publisher.withRetry('테스트', async () => {
      tries += 1;
      const e = new Error('토큰 만료');
      e.isAuthError = true;
      throw e;
    })
  );
  assert.equal(tries, 1);
});

test('withRetry: 재시도 불가 오류도 한 번만 시도한다', async () => {
  let tries = 0;
  await assert.rejects(() =>
    publisher.withRetry('테스트', async () => {
      tries += 1;
      throw new Error('영구 실패');
    })
  );
  assert.equal(tries, 1);
});

test('withRetry: 재시도 가능한 오류는 다시 시도해 성공한다', async () => {
  let tries = 0;
  const out = await publisher.withRetry(
    '테스트',
    async () => {
      tries += 1;
      if (tries === 1) {
        const e = new Error('일시 오류');
        e.isRetryable = true;
        throw e;
      }
      return 'ok';
    },
    2
  );
  assert.equal(out, 'ok');
  assert.equal(tries, 2);
});
