

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 이 프로젝트가 하는 일

`threads-auto-poster` — Threads(`@flag_21`) 자동 포스팅. 텍스트 게시물 + 연쇄 댓글(Reply Chain)을 하루 1회 스케줄로 발행한다. 폴더 이름은 "블로그 자동화"지만 코드가 다루는 대상은 네이버 블로그가 아니라 Threads다(블로그는 `content/blog-drafts/`의 초안·`docs/CONTENT-PLAN.md`까지만).

의존성 3개뿐(`axios`, `dotenv`, `node-cron`). Node 20+ CommonJS. 순수 Node `node:test` 러너.

## 명령어

```bash
npm install
node index.js --setup          # 단기 토큰 → 장기 토큰 교환, data/token.json 저장 (처음 한 번)
node index.js --token-status   # 토큰 잔여 일수·계정 확인
node index.js --dry-run        # API 호출 없이 파이프라인 점검 (안전)
node index.js --now            # 지금 1건 발행
node scheduler.js              # 상시 실행 (기본 매일 09:00 KST)
npm test                       # node --test test/*.test.js (30개)
node --test test/unit.test.js  # 단일 파일 테스트
```

## 아키텍처

`index.js`의 `run()`이 오케스트레이터다. 흐름:

1. **락** (`data/.lock`, PID 기반) — 중복 실행 방지. 죽은 프로세스 락은 자동 삭제.
2. **하루 상한** — `history.countToday()`(KST 기준)가 `MAX_POSTS_PER_DAY` 이상이면 종료.
3. **소스에서 1건 픽** — `sources/index.js`의 `fetchNext()`가 `SOURCES` 순서대로 각 소스의 `fetchNext`를 호출, 첫 non-null 반환.
4. **발행** — `core/publisher.js`의 `publishThread()`.
5. **후처리** — 성공/중복이면 `source.onPublished()`, 실패면 `source.onFailed()` (queue 소스는 파일을 `published/`·`failed/`로 이동).

### 레이어 경계

- `core/threadsClient.js` — Threads Graph API 호출의 **유일한** 지점. axios 래핑, 오류를 `ThreadsApiError`로 정규화(`isRetryable` / `isAuthError` 플래그). API를 만질 일은 여기만 고친다.
- `core/publisher.js` — 발행 로직. `postOne()` = 컨테이너 생성 → `FINISHED` 폴링 → publish 를 한 묶음으로 재시도. 메인 발행 후 각 댓글을 **직전 항목에 체이닝**(`reply_to_id = 직전 id`).
- `core/token.js` — 토큰 생명주기. 만료 7일 전 자동 갱신(24h 이내 재갱신 불가), 갱신 실패해도 기존 토큰 유효하면 발행 진행.
- `core/history.js` / `validator.js` / `logger.js` — 이력(JSONL)·검증·로깅. 사이드이펙트 격리.
- `sources/` — 콘텐츠 소스. 각 소스는 `{ name, fetchNext, onPublished, onFailed }` 인터페이스. 현재 `queueSource` 하나. 새 소스는 파일 추가 후 `sources/index.js`의 `available`에 등록.

### 발행 프로토콜 (한 게시물 = 3 API 호출)

Threads Graph API는 "즉시 게시"가 아니라 **컨테이너 → 폴링 → 발행** 2단계다. `postOne()`(`core/publisher.js`)이 이 셋을 한 묶음으로 재시도한다.

1. `createTextContainer({ text, replyToId, linkAttachment })` → `POST /{userId}/threads` (`media_type=TEXT`). 컨테이너 id 반환.
2. `waitUntilFinished(containerId)` → `status`가 `FINISHED`/`PUBLISHED` 될 때까지 `GET /{containerId}` 폴링(1s 간격, 최대 10회). `ERROR`/`EXPIRED`면 재시도 불가 오류, 10회 초과면 재시도 가능 오류.
3. `publish(containerId)` → `POST /{userId}/threads_publish` (`creation_id=containerId`). 최종 게시물 id 반환.

연쇄 댓글은 메인 발행 후 `REPLY_DELAY_MS`(기본 5s) 간격으로 하나씩, **각 댓글의 `reply_to_id`를 직전 게시물 id로** 세팅해 사슬을 만든다(메인 → 댓글1 → 댓글2 …). 중간에 실패하면 `mainId`가 있으므로 `partial`.

### 토큰 생명주기 (`core/token.js`)

- `--setup`: `.env`의 단기 토큰을 `exchangeLongLivedToken`(app secret은 **이 호출에만** 사용)으로 장기 토큰 교환 → `getMe()`로 계정 확인 → `data/token.json` 저장. 성공 후 `.env`의 단기 토큰 줄은 지워야 한다.
- `ensureValid()`(발행 직전 호출): 계정 가드 검사 → 만료 확인 → 필요 시 갱신. `shouldRefresh`는 잔여 < 7일 **그리고** 마지막 갱신 후 24h 경과일 때만 true(24h 이내 재갱신은 API가 막음).
- 갱신 실패는 발행을 막지 않는다(기존 토큰이 아직 유효하므로). 단 잔여 < 2일이면 `ERROR` 레벨로 올린다.

### 데이터 (모두 gitignore, 코드가 자동 생성)

- `data/token.json` — 장기 토큰·계정·만료. **커밋 금지.**
- `data/history.jsonl` — 1행 1건. `status`: `success`/`partial`/`failed`/`skipped-duplicate`/`skipped-validation`.
- `content/queue/` → 발행 대기(파일명 오름차순 = 발행 순서, `YYYY-MM-DD_` 접두어). `drafts/`는 발행 안 함. 성공 시 `published/`, 실패 시 `failed/`로 자동 이동.
- `logs/YYYY-MM-DD.log` — 30일 지나면 기동 시 자동 삭제. 토큰·시크릿은 `****` 마스킹.

## 큐 파일 형식 (`content/queue/`)

파일명 오름차순이 발행 순서다. `queueSource.parseFile`이 확장자로 분기한다.

**JSON** (`.json`)
```json
{
  "text": "메인 본문 (500자 이내)",
  "replies": ["첫 댓글", "둘째 댓글"],
  "link": "https://blog.naver.com/rudatech/223...",
  "publishAt": "2026-09-05T09:00:00+09:00"
}
```

**Markdown** (`.md`) — 선택적 front-matter(`key: value`, 외부 라이브러리 없이 단순 파싱) + `---` 줄로 본문·댓글 분리. 첫 블록이 본문, 나머지가 댓글.

`link`·`publishAt`은 선택. `publishAt`이 미래면 그 파일은 건너뛰고 다음 파일을 본다(발행 취소가 아니라 지연). BOM(`﻿`)은 파싱 전에 제거한다.

## 설정 (`config.js` + `.env`)

`config.js`가 `.env`를 읽어 하나의 객체로 노출하고 경로도 여기서 계산한다(`config.paths.*`). 코드에서 상대경로를 직접 쓰지 말고 `config.paths`를 쓸 것. 주요 knob:

| 키 | 기본 | 역할 |
|---|---|---|
| `MAX_POSTS_PER_DAY` | 1 | KST 기준 하루 발행 상한 |
| `POST_CRON` / `TZ` | `0 9 * * *` / `Asia/Seoul` | 스케줄 |
| `REPLY_DELAY_MS` | 5000 | 댓글 사이 간격 |
| `PUBLISH_RETRY` | 3 | 재시도 횟수(2s→4s→8s) |
| `TOKEN_REFRESH_BEFORE_DAYS` | 7 | 만료 며칠 전 갱신 |
| `SOURCES` | `queue` | 활성 소스(쉼표 구분, 순서 = 우선순위) |
| `BANNED_WORDS` | (없음) | 본문·댓글에 있으면 발행 차단 |
| `EXPECTED_THREADS_USERNAME` | `flag_21` | 계정 가드(빈 값이면 검사 안 함) |
| `NOTIFY_WEBHOOK_URL` | (없음) | 실패·토큰 임박 알림 웹훅(빈 값이면 알림 안 보냄) |

고정 상수(`maxTextLength=500`, 폴링 간격·횟수, HTTP 타임아웃, 로그 보관일)는 `config.js` 하단에 하드코딩. 필수 키 검사는 `assertRequired` — 발행엔 `REQUIRED_RUN`, setup엔 `REQUIRED_SETUP`.

## 이 코드베이스에서 반드시 지킬 것

- **계정 가드가 핵심 안전장치.** `EXPECTED_THREADS_USERNAME`(기본 `flag_21`)와 토큰 계정이 다르면 발행을 거부(`token.assertExpectedAccount`). 다른 계정에 잘못 올리는 사고를 막는 장치이므로 우회하지 말 것.
- **댓글 파라미터는 `reply_to_id`** — 원본 가이드의 `reply_to_thread_key`가 아니다(TDD 4.1). 계약 테스트(`test/threadsClient.test.js`)가 파라미터명을 고정한다. 바꾸면 발행이 조용히 깨진다.
- **오류 재시도는 플래그로만.** 429·5xx·네트워크 = `isRetryable`(2s→4s→8s 백오프). 190/401/403 = `isAuthError`(즉시 중단). 새 오류 처리를 넣을 땐 `normalizeError`에서 플래그를 세팅하지, 호출부에서 상태코드를 다시 분기하지 말 것.
- **500자 초과는 발행 안 하고 `skipped-validation`** — 파일은 고칠 수 있게 큐에 남긴다(다른 skip과 달리 `onPublished` 호출 안 함).
- **댓글 중간 실패 = `partial`.** 메인+댓글 k개는 이미 올라간 상태로 파일이 `failed/`로 감. 자동 이어쓰기 없음 — 재발행 시 올라간 k개를 수동으로 지우고 큐에 다시 넣어야 한다.
- **테스트는 네트워크 없이 돈다.** 계약 테스트는 `ThreadsClient`의 axios 어댑터를 갈아끼워 검증. 새 API 호출을 추가하면 같은 방식으로 계약 테스트를 붙일 것.

## 설계 문서

`docs/` — PRD.md(요구사항), TDD.md(기술 설계·구현 순서 12장, 미결 항목 13장), ADR.md(결정 기록), CONTENT-PLAN.md(콘텐츠 운영). 결정을 바꿀 땐 ADR 항목을 지우지 말고 `Superseded by`로 표시.

## 아직 없는 것 (확장 지점)

- 2차 `llmSource`(Claude API 생성) — `sources/`에 추가 후 `available`에 등록. `.env.example`에 `ANTHROPIC_API_KEY` 등 자리 있음.
- 3차 `rssSource`(네이버 블로그 RSS 폴링) — `scheduler.js`에 폴링 스케줄 추가 지점 주석 있음.
- `link_attachment` 미리보기 카드 동작 확인(TDD 13-2) — 이 코드 경로는 아직 한 번도 실행된 적이 없다. 큐 파일에 `link`를 넣고 실제로 1건 발행해야 확인된다.
- 댓글 중간 실패 시 자동 이어쓰기(TDD 13-1) — 보류. `partial`이 2건 더 쌓이면 재착수.

알림은 이미 있다 — `core/notify.js`가 `NOTIFY_WEBHOOK_URL`로 POST 1회를 보낸다(ADR-012). 호출부는 `index.js` 발행 실패 catch와 `core/token.js` 잔여 2일 미만 두 곳뿐이고, 성공 알림은 보내지 않는다.
