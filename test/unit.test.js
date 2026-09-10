'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const validator = require('../core/validator');
const history = require('../core/history');
const queueSource = require('../sources/queueSource');
const token = require('../core/token');
const notify = require('../core/notify');
const config = require('../config');
const index = require('../index');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------- validator ----------
test('validator: 정상 항목을 통과시킨다', () => {
  const r = validator.validate({ text: '본문', replies: ['댓글1', '댓글2'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('validator: 500자 초과를 잡는다', () => {
  const r = validator.validate({ text: 'ㄱ'.repeat(501), replies: [] });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /500자를 넘습니다 \(501자\)/);
});

test('validator: 댓글 500자 초과를 인덱스와 함께 잡는다', () => {
  const r = validator.validate({ text: 'ok', replies: ['짧음', 'ㄴ'.repeat(600)] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /replies\[1\]/);
});

test('validator: 빈 text를 잡는다', () => {
  assert.equal(validator.validate({ text: '   ', replies: [] }).ok, false);
});

test('validator: 금칙어를 잡는다', () => {
  const r = validator.validate({ text: '이건 금칙어 포함', replies: [] }, { bannedWords: ['금칙어'] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /금칙어 포함/);
});

test('validator: 잘못된 link와 publishAt을 잡는다', () => {
  const r = validator.validate({ text: 'ok', replies: [], link: 'ftp://x', publishAt: 'not-a-date' });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
});

// 회귀: validator는 replies 없는 항목을 통과시키는데 publisher가 .length를 바로 읽어
// TypeError로 죽을 수 있었다. 통과한 항목은 replies가 반드시 배열이어야 한다.
test('validator: replies가 없으면 통과시키되 빈 배열로 확정한다', () => {
  const item = { text: '본문' };
  const r = validator.validate(item);
  assert.equal(r.ok, true);
  assert.deepEqual(item.replies, [], 'publisher가 바로 .length를 읽어도 안전해야 한다');
});

test('validator: 검증 실패한 항목은 replies를 건드리지 않는다', () => {
  const item = { text: '' };
  assert.equal(validator.validate(item).ok, false);
  assert.equal(item.replies, undefined);
});

// ---------- history ----------
test('history: 같은 id 또는 같은 본문 해시를 중복으로 본다', () => {
  const d = tmpdir('hist-');
  const f = path.join(d, 'history.jsonl');
  history.append({ ts: new Date().toISOString(), id: 'a.json', textHash: history.hashText('본문A'), status: 'success' }, f);

  assert.equal(history.isDuplicate({ id: 'a.json', text: '다른 본문' }, f), true, 'id 일치');
  assert.equal(history.isDuplicate({ id: 'b.json', text: '본문A' }, f), true, '본문 해시 일치');
  assert.equal(history.isDuplicate({ id: 'b.json', text: '본문B' }, f), false);
});

test('history: 실패 이력은 중복으로 치지 않는다', () => {
  const d = tmpdir('hist2-');
  const f = path.join(d, 'history.jsonl');
  history.append({ ts: new Date().toISOString(), id: 'a.json', textHash: history.hashText('X'), status: 'failed' }, f);
  assert.equal(history.isDuplicate({ id: 'a.json', text: 'X' }, f), false);
});

test('history: KST 기준으로 오늘 발행 건수를 센다', () => {
  const d = tmpdir('hist3-');
  const f = path.join(d, 'history.jsonl');
  // 2026-09-05 00:30 KST = 2026-09-04T15:30Z → KST로는 9/5
  history.append({ ts: '2026-09-04T15:30:00.000Z', id: '1', textHash: 'h1', status: 'success', mainId: 'm1' }, f);
  // 2026-09-04 23:00 KST = 2026-09-04T14:00Z → KST로는 9/4
  history.append({ ts: '2026-09-04T14:00:00.000Z', id: '2', textHash: 'h2', status: 'success', mainId: 'm2' }, f);
  const now = new Date('2026-09-04T16:00:00.000Z'); // KST 9/5 01:00
  assert.equal(history.countToday(f, now), 1);
});

// 회귀: 2026-09-07에 partial이 상한에 안 잡혀 같은 날 2건이 발행됐다 (ADR-015).
test('history: partial도 하루 상한에 포함된다 — 메인은 이미 올라갔으므로', () => {
  const d = tmpdir('hist4-');
  const f = path.join(d, 'history.jsonl');
  const ts = '2026-09-04T15:30:00.000Z'; // KST 9/5
  history.append({ ts, id: '1', textHash: 'h1', status: 'partial', mainId: 'm1', publishedReplies: 0 }, f);
  const now = new Date('2026-09-04T16:00:00.000Z');
  assert.equal(history.countToday(f, now), 1);
});

test('history: 발행되지 않은 이력(mainId 없음)은 상한에 안 잡힌다', () => {
  const d = tmpdir('hist5-');
  const f = path.join(d, 'history.jsonl');
  const ts = '2026-09-04T15:30:00.000Z';
  history.append({ ts, id: '1', textHash: 'h1', status: 'failed', mainId: null }, f);
  history.append({ ts, id: '2', textHash: 'h2', status: 'skipped-validation', mainId: null }, f);
  const now = new Date('2026-09-04T16:00:00.000Z');
  assert.equal(history.countToday(f, now), 0);
});

// ---------- queueSource ----------
test('queueSource: JSON을 파싱한다', async () => {
  const d = tmpdir('q-');
  fs.writeFileSync(
    path.join(d, '2026-09-05_a.json'),
    JSON.stringify({ text: '메인', replies: ['댓1', '댓2'], publishAt: '2026-01-01T00:00:00+09:00' }),
    'utf8'
  );
  const item = await queueSource.fetchNext({ queueDir: d, now: '2026-09-05T00:00:00+09:00' });
  assert.equal(item.text, '메인');
  assert.deepEqual(item.replies, ['댓1', '댓2']);
  assert.equal(item.id, '2026-09-05_a.json');
  assert.equal(item.source, 'queue');
});

test('queueSource: Markdown front-matter를 파싱한다', () => {
  const p = queueSource.parseMarkdown(
    '---\nlink: https://example.com/x\npublishAt: 2026-09-05T09:00:00+09:00\n---\n메인 본문\n\n---\n첫 댓글\n\n---\n둘째 댓글\n'
  );
  assert.equal(p.text, '메인 본문');
  assert.deepEqual(p.replies, ['첫 댓글', '둘째 댓글']);
  assert.equal(p.link, 'https://example.com/x');
});

// 회귀: meta를 통째로 펼치면 front-matter가 파싱된 본문을 덮어썼다.
test('queueSource: front-matter의 text/replies는 본문을 덮지 못한다', () => {
  const p = queueSource.parseMarkdown(
    '---\ntext: 덮어쓰기 시도\nreplies: 덮어쓰기 시도\nlink: https://example.com/x\n---\n진짜 본문\n\n---\n진짜 댓글\n'
  );
  assert.equal(p.text, '진짜 본문');
  assert.deepEqual(p.replies, ['진짜 댓글']);
  assert.equal(p.link, 'https://example.com/x');
});

test('queueSource: publishAt이 미래면 건너뛰고 다음 파일을 본다', async () => {
  const d = tmpdir('q2-');
  fs.writeFileSync(path.join(d, '2026-09-01_future.json'), JSON.stringify({ text: '미래', publishAt: '2030-01-01T00:00:00+09:00' }), 'utf8');
  fs.writeFileSync(path.join(d, '2026-09-02_ready.json'), JSON.stringify({ text: '지금' }), 'utf8');
  const item = await queueSource.fetchNext({ queueDir: d, now: '2026-09-05T00:00:00+09:00' });
  assert.equal(item.text, '지금');
});

test('queueSource: 파일명 오름차순이 발행 순서다', async () => {
  const d = tmpdir('q3-');
  fs.writeFileSync(path.join(d, '2026-09-09_b.json'), JSON.stringify({ text: '나중' }), 'utf8');
  fs.writeFileSync(path.join(d, '2026-09-03_a.json'), JSON.stringify({ text: '먼저' }), 'utf8');
  const item = await queueSource.fetchNext({ queueDir: d, now: '2026-12-01T00:00:00+09:00' });
  assert.equal(item.text, '먼저');
});

test('queueSource: 깨진 JSON은 건너뛰고 계속 진행한다', async () => {
  const d = tmpdir('q4-');
  fs.writeFileSync(path.join(d, '2026-09-01_broken.json'), '{ not json', 'utf8');
  fs.writeFileSync(path.join(d, '2026-09-02_ok.json'), JSON.stringify({ text: '정상' }), 'utf8');
  const item = await queueSource.fetchNext({ queueDir: d, now: '2026-12-01T00:00:00+09:00' });
  assert.equal(item.text, '정상');
});

test('queueSource: 큐가 비면 null', async () => {
  const item = await queueSource.fetchNext({ queueDir: tmpdir('q5-'), now: new Date() });
  assert.equal(item, null);
});

// ---------- token 만료 계산 ----------
const DAY = 86400000;

test('token: 만료 7일 전이고 마지막 갱신 후 24시간 지났으면 갱신 대상', () => {
  const now = Date.now();
  const t = {
    issuedAt: new Date(now - 55 * DAY).toISOString(),
    expiresAt: new Date(now + 5 * DAY).toISOString(),
    lastRefreshAt: null,
  };
  assert.equal(token.shouldRefresh(t, now, 7), true);
});

test('token: 만료가 멀면 갱신하지 않는다', () => {
  const now = Date.now();
  const t = { issuedAt: new Date(now - DAY).toISOString(), expiresAt: new Date(now + 40 * DAY).toISOString(), lastRefreshAt: null };
  assert.equal(token.shouldRefresh(t, now, 7), false);
});

test('token: 발급 24시간 이내에는 갱신하지 않는다 (API 제약)', () => {
  const now = Date.now();
  const t = { issuedAt: new Date(now - 3600000).toISOString(), expiresAt: new Date(now + 2 * DAY).toISOString(), lastRefreshAt: null };
  assert.equal(token.shouldRefresh(t, now, 7), false);
});

test('token: daysLeft 계산', () => {
  const now = Date.now();
  const t = { expiresAt: new Date(now + 10 * DAY).toISOString() };
  assert.ok(Math.abs(token.daysLeft(t, now) - 10) < 0.01);
});

// ---------- 발행 계정 가드 ----------
test('token: 계정이 일치하면 통과', () => {
  assert.doesNotThrow(() => token.assertExpectedAccount({ username: 'flag_21' }, 'flag_21'));
});

test('token: 대소문자와 @는 무시한다', () => {
  assert.doesNotThrow(() => token.assertExpectedAccount({ username: '@FLAG_21' }, 'flag_21'));
});

test('token: 계정이 다르면 발행을 막는다', () => {
  assert.throws(
    () => token.assertExpectedAccount({ username: 'flag2ejb' }, 'flag_21'),
    (e) => {
      assert.match(e.message, /발행 계정 불일치/);
      assert.match(e.message, /@flag2ejb/);
      assert.equal(e.isAuthError, true);
      return true;
    }
  );
});

test('token: EXPECTED가 비어 있으면 검사하지 않는다', () => {
  assert.doesNotThrow(() => token.assertExpectedAccount({ username: '아무거나' }, ''));
});

// ---------- 락 (PID 재사용 방어) ----------
test('락: 나이가 상한을 넘으면 pid가 살아 있어도 stale로 본다', () => {
  const now = Date.now();
  const old = new Date(now - 2 * 3600000).toISOString(); // 2시간 전
  assert.equal(index.isStaleLock({ pid: 1, startedAt: old }, now, 3600000), true);
});

test('락: 방금 만든 락은 stale이 아니다', () => {
  const now = Date.now();
  const fresh = new Date(now - 60000).toISOString(); // 1분 전
  assert.equal(index.isStaleLock({ pid: 1, startedAt: fresh }, now, 3600000), false);
});

test('락: startedAt이 없거나 깨졌으면 믿지 않고 stale로 본다', () => {
  const now = Date.now();
  assert.equal(index.isStaleLock({ pid: 1 }, now, 3600000), true);
  assert.equal(index.isStaleLock({ pid: 1, startedAt: '이상한값' }, now, 3600000), true);
});

// ---------- 알림 훅 ----------
test('notify: 웹훅 URL이 없으면 전송하지 않는다', async () => {
  const saved = config.notifyWebhookUrl;
  config.notifyWebhookUrl = '';
  try {
    assert.equal(await notify.send('실패'), false);
  } finally {
    config.notifyWebhookUrl = saved;
  }
});

test('notify: 전송 실패해도 예외를 던지지 않는다', async () => {
  const saved = config.notifyWebhookUrl;
  config.notifyWebhookUrl = 'http://127.0.0.1:1/webhook'; // 아무도 듣지 않는 포트
  try {
    assert.equal(await notify.send('실패'), false);
  } finally {
    config.notifyWebhookUrl = saved;
  }
});
