# Threads 자동 포스팅 — 1차 MVP

[TDD.md](./docs/TDD.md) 12장 구현 순서 1~7단계 구현본.
텍스트 게시물 + 연쇄 댓글(Reply Chain) + 일 1회 스케줄 발행.

## 설정 (처음 한 번)

> **발행 계정: `@flag_21`**
> Threads 계정은 코드가 아니라 **`--setup` 때 발급한 토큰이 결정합니다.**
> Graph API 탐색기에서 단기 토큰을 만들 때 반드시 **@flag_21로 로그인한 상태**여야 합니다.
> 다른 계정으로 토큰을 만들면 그 계정에 글이 올라갑니다.
> `--setup` 후 출력되는 `@계정명`이 `flag_21`인지 꼭 확인하세요.
> 계정을 바꾸려면 `data/token.json`을 지우고 `--setup`을 다시 실행하면 됩니다.

```bash
cd "D:\++ 2026년도 프로젝트\블로그 자동화"
npm install
copy .env.example .env
```

`.env`를 열고 채웁니다.

| 키 | 값 |
|---|---|
| `THREADS_APP_ID` | Meta 앱 ID |
| `THREADS_APP_SECRET` | 앱 시크릿 |
| `THREADS_SHORT_LIVED_TOKEN` | Graph API 탐색기에서 발급한 단기 토큰 |

그다음 장기 토큰으로 교환합니다.

```bash
node index.js --setup
```

성공하면 `data/token.json`이 생기고 `@계정명`과 만료일이 출력됩니다.
**여기 찍히는 계정이 `flag_21`인지 먼저 확인하세요.** 다르면 `data/token.json`을 지우고
@flag_21로 다시 단기 토큰을 받아 `--setup`을 다시 돌리세요.

계정이 맞으면 **출력 안내대로 `.env`의 `THREADS_SHORT_LIVED_TOKEN` 줄을 지우세요.** 이후로는 필요 없습니다.

```bash
node index.js --token-status    # 잔여 일수 확인
```

## 발행

```bash
node index.js --dry-run    # API 호출 없이 파이프라인 점검 (안전)
node index.js --now        # 지금 1건 발행
node scheduler.js          # 상시 실행 (기본 매일 09:00 KST)
```

### 첫 실전 발행 순서

1. `node index.js --dry-run` — 어떤 파일이 선택되고 글자 수가 몇인지 확인
2. `node index.js --now` — 실제 발행
3. **Threads 앱에서 댓글 2~5편이 원글 아래에 달렸는지 눈으로 확인**
   → 2026-09-07 발행 2건에서 댓글 4개 체인이 모두 성공해 확인이 끝났습니다(ADR-009).
   공식 파라미터 `reply_to_id`를 쓰며 계약 테스트가 파라미터명을 고정합니다.
4. 확인 끝나면 테스트 글은 수동 삭제

### 링크 첨부 확인 (아직 안 끝난 항목)

`link_attachment` 경로는 아직 한 번도 실행된 적이 없습니다. 큐 파일 중 `link`를 쓰는 게 없어서입니다.
미리보기 카드가 뜨는지, 본문 안 URL과 중복 표기되는지는 실제로 한 번 올려봐야 알 수 있습니다(TDD 13-2).

1. 큐 파일 하나에 `"link": "https://blog.naver.com/rudatech/223..."` 추가
2. `node index.js --dry-run` — 로그에 `link_attachment: ...` 줄이 찍히는지 확인
3. `node index.js --now`
4. Threads 앱에서 **미리보기 카드가 뜨는지 / 본문 URL과 중복되지 않는지** 확인 후 TDD 13-2에 결과 기록

## 실패 알림 (선택)

`.env`에 `NOTIFY_WEBHOOK_URL`을 넣으면 발행 실패와 토큰 만료 임박을 웹훅으로 받습니다.
비워 두면 알림을 보내지 않습니다(기본값).

```
NOTIFY_WEBHOOK_URL=https://hooks.slack.com/services/...
```

Slack·Discord·카카오워크 등 평문 웹훅이면 URL만 바꾸면 됩니다. 알리는 경우는 두 가지뿐입니다.

- 발행 실패, 그리고 댓글 중간 실패(`partial` — 이미 올라간 댓글 개수를 함께 보냅니다)
- 토큰 갱신 실패 + 잔여 2일 미만

성공 알림은 보내지 않습니다. 알림 전송이 실패해도 발행은 그대로 진행됩니다.

## 큐에 글 넣기

`content/queue/`에 파일을 두면 됩니다. **파일명 오름차순이 발행 순서**라 `YYYY-MM-DD_` 접두어를 붙이세요.

**JSON**
```json
{
  "text": "메인 본문 (500자 이내)",
  "replies": ["첫 댓글", "둘째 댓글"],
  "link": "https://blog.naver.com/rudatech/223...",
  "publishAt": "2026-09-05T09:00:00+09:00"
}
```

**Markdown** — `---` 로 본문과 댓글을 나눕니다.
```md
---
link: https://blog.naver.com/rudatech/223...
publishAt: 2026-09-05T09:00:00+09:00
---
메인 본문

---
첫 댓글

---
둘째 댓글
```

`link`와 `publishAt`은 선택입니다. `publishAt`이 미래면 그 파일은 건너뛰고 다음 파일을 봅니다.

### 폴더 흐름

```
content/queue/      발행 대기 (여기에 넣으세요)
content/drafts/     승인 대기 — 발행되지 않습니다
content/published/  발행 성공 시 자동 이동
content/failed/     실패 시 자동 이동
```

## 상시 실행 등록 (Windows)

작업 스케줄러에서:

1. 작업 만들기 → 트리거: **로그온할 때**
2. 동작: 프로그램 시작
   - 프로그램: `node`
   - 인수: `scheduler.js`
   - **시작 위치: 프로젝트 루트** (이걸 비우면 `.env`와 `data/`를 못 찾습니다)
3. 설정 → "작업이 실패하면 다시 시작" 체크

## 동작 규칙

- **하루 상한**: `MAX_POSTS_PER_DAY`(기본 1). PC가 꺼져 있던 날의 밀린 글은 하루 1건씩 소화됩니다.
- **중복 방지**: 같은 파일명 또는 같은 본문 해시가 `success`로 이력에 있으면 발행하지 않습니다.
- **락**: `data/.lock`. 죽은 프로세스의 락은 자동 삭제되고, 살아 있으면 그 회차를 건너뜁니다.
- **재시도**: 429·5xx·네트워크 오류에 한해 2s → 4s → 8s. 토큰 오류(190/401/403)는 즉시 중단합니다.
- **토큰 갱신**: 만료 7일 전 자동 갱신. 갱신 실패해도 기존 토큰이 유효하면 발행은 진행되고, 잔여 2일 미만이면 `ERROR`로 올립니다.
- **500자 초과**: 발행하지 않고 `skipped-validation`. 파일은 고칠 수 있도록 큐에 남습니다.

## 댓글이 중간에 실패했다면

이력에 `status: "partial"`, `publishedReplies: k`가 남고 파일은 `failed/`로 갑니다.
**재발행할 때는 이미 올라간 댓글 k개를 파일에서 지우고** `queue/`에 다시 넣으세요.
자동 이어쓰기는 1차에 넣지 않았습니다 (TDD 13장 미결 1).

## 이력·로그

- `data/history.jsonl` — 1행 1건. `status`는 `success` / `partial` / `failed` / `skipped-duplicate` / `skipped-validation`
- `logs/YYYY-MM-DD.log` — 30일 지난 파일은 기동 시 자동 삭제
- 로그에 `access_token`·`client_secret`은 `****`로 마스킹됩니다

## 테스트

```bash
npm test
```

30개 통과. 검증(글자 수·금칙어·필수 필드), 이력(중복·KST 일일 카운트), 큐 파싱(JSON·Markdown·정렬·미래 publishAt·깨진 파일), 토큰 만료 계산, 그리고 Threads API 계약 테스트(`reply_to_id`·`creation_id` 파라미터명, 오류 정규화)를 덮습니다.

계약 테스트는 axios 어댑터를 갈아끼워 네트워크 없이 돕니다.

## 아직 없는 것

- 2차 `llmSource` (Claude API 생성) — `sources/`에 파일 추가 후 `sources/index.js`의 `available`에 등록하면 됩니다
- 3차 `rssSource` (네이버 블로그 RSS 폴링)
- 댓글 중간 실패 시 자동 이어쓰기 — 원인이던 전파 지연이 재시도로 해소되어 보류(TDD 13-1)
- `link_attachment` 미리보기 카드 동작 확인 — 위 "링크 첨부 확인" 절차대로 한 번 발행해야 끝납니다(TDD 13-2)
