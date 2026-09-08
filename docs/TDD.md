# TDD — Threads 자동 포스팅 프로그램 기술 설계 문서

| 항목 | 내용 |
|---|---|
| 문서 버전 | v0.2 |
| 작성일 | 2026-09-02 (개정 2026-09-07) |
| 대상 | [PRD.md](./PRD.md) v0.1의 1차 MVP + 2차·3차 확장 구조 |
| 관련 결정 | [ADR.md](./ADR.md) |
| 런타임 | Node.js 20 LTS (CommonJS), Windows 10/11 |

---

## 1. 시스템 개요

```
┌────────────────────────── 개인 Windows PC ──────────────────────────┐
│                                                                     │
│  scheduler.js ──(cron 0 9 * * *)──▶ index.js(run)                   │
│                                        │                            │
│        ┌───────────────────────────────┼─────────────────────┐      │
│        ▼                               ▼                     ▼      │
│  sources/                         core/publisher.js     core/token.js
│   ├ queueSource.js  (1차)              │                     │      │
│   ├ llmSource.js    (2차, Claude)      ▼                     ▼      │
│   └ rssSource.js    (3차, 네이버 RSS)  core/threadsClient.js ──▶ Threads Graph API
│        │                               │                            │
│        ▼                               ▼                            │
│  content/{queue,drafts,published,failed}/   data/{token.json,history.jsonl,.lock}
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

원본 가이드의 `threadsClient.js` + `index.js` + `scheduler.js` 3파일 구조를 유지하되, 콘텐츠 소스·토큰·이력을 별도 모듈로 분리하여 2차·3차 확장 시 `sources/`에 파일만 추가하면 되도록 한다.

---

## 2. 프로젝트 구조

```
블로그 자동화/                    # 현재 폴더 (프로젝트 루트)
├── docs/                         # PRD / TDD / ADR
├── .env                          # 사람이 입력하는 자격 증명 (git 제외)
├── .env.example                  # 키 이름만 있는 템플릿
├── .gitignore                    # .env, data/, logs/, node_modules/, content/published/
├── package.json
├── index.js                      # CLI 진입점 (--setup / --now / --dry-run / --token-status)
├── scheduler.js                  # node-cron 상시 실행 진입점
├── config.js                     # 환경변수 로딩 + 기본값 + 검증
├── core/
│   ├── threadsClient.js          # Threads API 호출 전용 (HTTP 계층)
│   ├── token.js                  # 토큰 교환/갱신/저장/만료 계산
│   ├── publisher.js              # 게시물+댓글 발행 오케스트레이션, 재시도
│   ├── history.js                # history.jsonl 기록·중복 검사
│   ├── validator.js              # 글자 수·필수 필드·금칙어 검증
│   └── logger.js                 # 콘솔 + 일별 파일 로그, 토큰 마스킹
├── sources/
│   ├── index.js                  # 활성 소스 목록 + 공통 인터페이스
│   ├── queueSource.js            # content/queue/ 파일 읽기 (1차)
│   ├── llmSource.js              # Claude API 생성 (2차)
│   └── rssSource.js              # 네이버 블로그 RSS 폴링 (3차)
├── content/
│   ├── queue/                    # 발행 대기 (운영자가 파일 추가)
│   ├── drafts/                   # LLM 초안 (승인 대기)
│   ├── published/                # 발행 완료 (파일 이동)
│   ├── failed/                   # 최종 실패
│   ├── topics.md                 # 2차: 주제 목록
│   └── brand-voice.md            # 2차: 브랜드 톤 가이드
├── data/                         # 런타임 상태 (git 제외)
│   ├── token.json
│   ├── history.jsonl
│   ├── rss-seen.json
│   └── .lock
├── logs/                         # YYYY-MM-DD.log (git 제외)
└── test/                         # node:test 기반 단위 테스트
```

의존성: `axios`, `dotenv`, `node-cron` (1차) / `@anthropic-ai/sdk` (2차) / `rss-parser` (3차). 로그·테스트는 Node 내장 모듈(`fs`, `path`, `node:test`)만 사용한다.

---

## 3. 설정 (`config.js`)

`.env` 키와 기본값. 토큰 값은 `.env`에 두지 않고 `data/token.json`에 저장한다(ADR-003).

| 키 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `THREADS_APP_ID` | O | — | Meta 앱 ID |
| `THREADS_APP_SECRET` | O | — | 앱 시크릿 (토큰 교환·갱신에만 사용) |
| `THREADS_SHORT_LIVED_TOKEN` | setup 시 | — | Graph API 탐색기에서 발급한 단기 토큰. setup 후 삭제 권장 |
| `THREADS_REDIRECT_URI` | `--code` 사용 시 | — | OAuth 리디렉트 URI. Meta 앱에 등록된 값과 문자 그대로 같아야 함 |
| `THREADS_API_VERSION` | | `v1.0` | 엔드포인트 버전 상수 |
| `POST_CRON` | | `0 9 * * *` | 발행 스케줄 (KST) |
| `TZ` | | `Asia/Seoul` | node-cron timezone |
| `MAX_POSTS_PER_DAY` | | `1` | 하루 발행 상한 |
| `REPLY_DELAY_MS` | | `5000` | 게시 간 지연 |
| `PUBLISH_RETRY` | | `3` | 재시도 횟수 |
| `TOKEN_REFRESH_BEFORE_DAYS` | | `7` | 만료 며칠 전 갱신 |
| `SOURCES` | | `queue` | 활성 소스, 콤마 구분 (`queue,llm,rss`) |
| `EXPECTED_THREADS_USERNAME` | | (없음 = 검사 안 함) | 발행 계정 가드. 토큰 계정과 다르면 발행 거부(ADR-010). `.env.example`은 `flag_21`로 채워 배포 |
| `BANNED_WORDS` | | (없음) | 금칙어, 콤마 구분. 본문·댓글에 포함되면 `skipped-validation` |
| `ANTHROPIC_API_KEY` | 2차 | — | Claude API 키 |
| `LLM_MODEL` | 2차 | (최신 Sonnet 계열) | 생성 모델 |
| `AUTO_APPROVE` | 2차 | `false` | LLM 초안 자동 승인 |
| `NAVER_BLOG_ID` | 3차 | — | RSS 대상 블로그 ID |
| `RSS_POLL_CRON` | 3차 | `0 * * * *` | RSS 폴링 주기 |

`config.js`는 로딩 시 필수 키 누락을 검사하고, 누락 시 어떤 키가 없는지 명시하며 종료한다.

---

## 4. Threads API 연동 (`core/threadsClient.js`)

### 4.1 사용 엔드포인트
Base URL: `https://graph.threads.net`

| 용도 | 메서드/경로 | 주요 파라미터 |
|---|---|---|
| 인증 코드 → 단기 토큰 | `POST /oauth/access_token` | `grant_type=authorization_code`, `client_id`, `client_secret`, `redirect_uri`, `code` — **이 호출만 폼 바디**를 쓴다 |
| 장기 토큰 교환 | `GET /access_token` | `grant_type=th_exchange_token`, `client_secret`, `access_token`(단기) |
| 장기 토큰 갱신 | `GET /refresh_access_token` | `grant_type=th_refresh_token`, `access_token`(장기) |
| 사용자 조회 | `GET /v1.0/me` | `fields=id,username` |
| 컨테이너 생성 | `POST /v1.0/{user_id}/threads` | `media_type=TEXT`, `text`, `reply_to_id`(댓글), `link_attachment`(선택) |
| 컨테이너 상태 | `GET /v1.0/{container_id}` | `fields=status,error_message` |
| 발행 | `POST /v1.0/{user_id}/threads_publish` | `creation_id` |
| 발행 한도 조회 | `GET /v1.0/{user_id}/threads_publishing_limit` | `fields=quota_usage,config,reply_quota_usage,reply_config` |

> **원본 가이드와의 차이 (구현 시 주의)**
> 가이드 코드는 댓글 생성 시 `reply_to_thread_key`를 쓰지만, Threads API 공식 파라미터는 **`reply_to_id`** 이다. 구현 시 `reply_to_id`를 사용하고, 첫 실제 테스트에서 댓글이 원글 아래에 달리는지 확인한다.

### 4.2 클라이언트 설계
```js
class ThreadsClient {
  constructor({ accessToken, userId, apiVersion })
  exchangeLongLivedToken(shortToken, appSecret) → { access_token, expires_in }
  refreshLongLivedToken()                        → { access_token, expires_in }
  getMe()                                        → { id, username }
  createTextContainer({ text, replyToId, linkAttachment }) → containerId
  getContainerStatus(containerId)                → 'IN_PROGRESS'|'FINISHED'|'PUBLISHED'|'ERROR'|'EXPIRED'
  publish(containerId)                           → threadId
  getPublishingLimit()                           → { quota_usage, reply_quota_usage }
}
```
- axios 인스턴스에 `timeout: 15000`, 공통 `access_token` 주입.
- 모든 오류는 `ThreadsApiError { code, subcode, message, isRetryable, isAuthError }`로 정규화한다.
  - `isAuthError`: HTTP 401/403, 오류 코드 190(토큰 무효) → 재시도 없이 토큰 재설정 안내
  - `isRetryable`: HTTP 429, 5xx, 코드 4/17/32(레이트 리밋), 네트워크 오류
- 로그에는 토큰을 절대 남기지 않는다(`logger.mask()`로 `access_token=****` 처리).

### 4.3 발행 시퀀스
```
publisher.publishThread(item)
  │
  ├─ validator.validate(item)                   ← 500자·필수 필드·금칙어
  ├─ history.isDuplicate(item)                  ← 파일명 + 본문 SHA-256
  ├─ token.ensureValid()                        ← 만료 7일 전이면 refresh
  │
  ├─ [메인] createTextContainer(text, link) → waitUntil(FINISHED) → publish → mainId
  │
  └─ for reply in replies:
        sleep(REPLY_DELAY_MS)
        createTextContainer(reply, replyToId=lastId) → waitUntil(FINISHED) → publish → lastId
        history.appendPartial(...)                ← 댓글 단위로 진행 상황 기록
```
- `waitUntil(FINISHED)`: 1초 간격 최대 10회 상태 조회. 텍스트 컨테이너는 보통 즉시 FINISHED이지만, 가이드가 언급한 "타이밍 이슈"를 고정 대기 대신 상태 확인으로 해결한다.
- 재시도: 각 API 호출 단위로 `PUBLISH_RETRY`회, 백오프 `2s → 4s → 8s`. 컨테이너 생성은 성공했는데 publish가 실패한 경우 같은 `creation_id`로 재시도한다(컨테이너 24시간 유효).
- 댓글 중간 실패 시 이력에 `status: "partial"`, `publishedReplies: k`를 남기고 파일은 `failed/`로 이동한다. 재발행 시 운영자가 이미 올라간 댓글을 파일에서 제거한 뒤 큐에 다시 넣는다(1차에서는 자동 이어쓰기 미지원 — 미결 사항 참고).

---

## 5. 토큰 관리 (`core/token.js`)

`data/token.json`
```json
{
  "accessToken": "…",
  "userId": "1784…",
  "username": "flag_21",
  "issuedAt": "2026-09-02T00:00:00.000Z",
  "expiresAt": "2026-11-01T00:00:00.000Z",
  "lastRefreshAt": null
}
```
- `setup()`: `.env`의 단기 토큰으로 교환 → `getMe()` → 파일 저장. 성공 시 `.env`에서 단기 토큰을 지우라고 안내.
- `assertExpectedAccount(token)`: 토큰의 `username`과 `EXPECTED_THREADS_USERNAME`을 대소문자 무시 비교. 다르면 `isAuthError`로 즉시 중단한다(ADR-010). 발행 경로에서는 `ensureValid()`가 만료 검사보다 **먼저** 호출한다.
- `ensureValid()`: 계정 가드 → 만료 확인 → 필요 시 갱신 순서. `expiresAt - now < TOKEN_REFRESH_BEFORE_DAYS` 이면 `refreshLongLivedToken()` 후 저장. 발급 24시간 이내에는 갱신을 시도하지 않는다(API 제약).
- `status()`: `--token-status`용. 잔여 일수와 마지막 갱신 시각 출력.
- 갱신 실패는 발행을 막지 않는다(기존 토큰이 아직 유효). 단, 잔여 2일 미만이면 `WARN`을 `ERROR`로 올리고 알림 훅을 호출한다.

---

## 6. 콘텐츠 소스 인터페이스 (`sources/`)

```js
// 모든 소스가 구현
module.exports = {
  name: 'queue',
  async fetchNext(ctx) → ContentItem | null,   // 발행할 1건 (없으면 null)
  async onPublished(item, result) {},           // 파일 이동 등 후처리
  async onFailed(item, error) {},
};
```

`ContentItem`
```ts
{
  id: string,            // 파일명 또는 생성 ID
  source: 'queue'|'llm'|'rss',
  text: string,          // 메인 본문 (≤500자)
  replies: string[],     // 연쇄 댓글 (각 ≤500자)
  link?: string,         // link_attachment
  publishAt?: string,    // ISO8601, 이후에만 발행
  meta?: object          // 원본 URL, 주제 등
}
```

`sources/index.js`는 `SOURCES` 순서대로 `fetchNext()`를 호출해 첫 번째 non-null 항목을 반환한다. 즉 큐에 글이 있으면 큐가 우선, 비어 있으면 LLM 생성, RSS 항목은 감지 즉시 큐 파일로 변환되므로 결국 큐를 통해 발행된다.

### 6.1 queueSource (1차)
파일 형식 두 가지를 지원한다.

**JSON** — `content/queue/2026-09-03_ai-doc-analysis.json`
```json
{
  "text": "지방의회 회의록 300쪽, 사람이 읽으면 이틀. RAG는 3분. 🧵",
  "replies": [
    "핵심은 검색 정확도입니다. 문서를 '의미 단위'로 잘라야 답변 품질이 올라갑니다.",
    "망분리 환경에서도 온프레미스 LLM으로 동일하게 구현 가능합니다. 문의는 프로필 링크로."
  ],
  "link": "https://blog.naver.com/rudatech/223…",
  "publishAt": "2026-09-03T09:00:00+09:00"
}
```

**Markdown (front-matter)** — `content/queue/2026-09-04_onprem-llm.md`
```md
---
link: https://blog.naver.com/rudatech/223…
publishAt: 2026-09-04T09:00:00+09:00
---
메인 본문…

---
첫 번째 댓글…

---
두 번째 댓글…
```
`---` 구분선으로 본문과 댓글을 나눈다. front-matter 파서는 단순 `key: value`만 지원(외부 라이브러리 불사용).

정렬: 파일명 오름차순 → 날짜 접두어(`YYYY-MM-DD_`)를 붙이면 발행 순서가 된다. `publishAt`이 미래인 파일은 건너뛰고 다음 파일을 본다.

### 6.2 llmSource (2차)
1. `content/topics.md`에서 `- [ ] 주제` 형식의 미사용 항목 1개 선택.
2. 시스템 프롬프트 = `content/brand-voice.md` + 출력 형식 지시(JSON: `text`, `replies[]`).
3. `@anthropic-ai/sdk`로 생성 → `validator`로 글자 수·CTA 포함 검증 → 실패 시 1회 재생성.
4. `content/drafts/`에 저장. `AUTO_APPROVE=true`면 `queue/`로 이동하고 topics 항목을 `- [x]`로 표시. 아니면 운영자가 확인 후 수동 이동.
5. `fetchNext()`는 자동 승인 모드일 때만 항목을 반환한다.

### 6.3 rssSource (3차)
- `RSS_POLL_CRON`으로 별도 스케줄. `rss-parser`로 `https://rss.blog.naver.com/{NAVER_BLOG_ID}.xml` 읽기.
- `data/rss-seen.json`에 없는 `guid`만 신규로 처리. 첫 실행 시에는 기존 글을 모두 seen 처리하여 과거 글이 한꺼번에 올라가지 않게 한다.
- 게시물 구성: 제목 + 요약(LLM 사용 가능 시 3문장 요약, 아니면 description 앞 200자) + 링크 첨부. 댓글 1개에 CTA.
- 카테고리/키워드 제외 필터(`RSS_EXCLUDE_KEYWORDS`)를 적용한 뒤 `content/queue/`에 JSON으로 저장 → queueSource가 발행.

---

## 7. 스케줄러 (`scheduler.js`)

```js
cron.schedule(POST_CRON, () => run({ mode: 'scheduled' }), { timezone: TZ });
if (SOURCES.includes('rss')) cron.schedule(RSS_POLL_CRON, rssSource.poll, { timezone: TZ });
```
- `run()` 시작 시 `data/.lock` 생성(pid, 시각). 존재하면 pid 생존 여부 확인 후 stale 락은 삭제, 살아 있으면 건너뜀.
- 하루 상한: `history`에서 오늘(KST) 성공 건수 조회 → `MAX_POSTS_PER_DAY` 이상이면 종료. PC가 꺼져 있던 날의 밀린 글은 이 상한 안에서 하루 1건씩 소화된다.
- Windows 상시 실행: 작업 스케줄러에 "로그온 시" 트리거로 `node scheduler.js` 등록(작업 디렉터리 = 프로젝트 루트). 절차는 README에 기술. PM2-windows-startup은 선택 사항(ADR-004).

---

## 8. 이력·로그

`data/history.jsonl` (1행 1건)
```json
{"ts":"2026-09-03T00:00:12.345Z","id":"2026-09-03_ai-doc-analysis.json","source":"queue","textHash":"sha256:…","mainId":"1807…","replyIds":["1807…","1807…"],"status":"success","error":null,"durationMs":21430}
```
- `status`: `success` | `partial` | `failed` | `skipped-duplicate` | `skipped-validation`
- 중복 검사: 같은 `id` 또는 같은 `textHash`가 `success`로 존재하면 발행하지 않는다.

로그: `logger.js`가 `[2026-09-03 09:00:12] [INFO] …` 형식으로 콘솔과 `logs/YYYY-MM-DD.log`에 동시 기록. 레벨 `DEBUG/INFO/WARN/ERROR`. 30일 지난 로그 파일은 기동 시 삭제.

---

## 9. 오류 처리 매트릭스

| 상황 | 감지 | 처리 |
|---|---|---|
| 토큰 무효(190, 401) | `isAuthError` | 즉시 중단, `ERROR` 로그 + 알림, `--setup` 재실행 안내 |
| 계정 불일치 | `assertExpectedAccount` | 발행 전 즉시 중단(`isAuthError`), `data/token.json` 삭제 후 재설정 안내 |
| 레이트 리밋(429, 코드 4/17/32) | `isRetryable` | 백오프 재시도, 3회 실패 시 해당 건 `failed/` 이동, 다음 스케줄에 재시도 안 함 |
| 컨테이너 ERROR/EXPIRED | 상태 조회 | `error_message` 기록, 컨테이너 새로 생성해 재시도 1회 |
| 본문 500자 초과 | validator | 발행 전 `skipped-validation`, 파일은 큐에 남기고 `WARN` |
| 네트워크 오류 | axios | 재시도 대상 |
| 큐 비어 있음 | queueSource null | `INFO` 로그 후 정상 종료 |
| 락 파일 존재 | scheduler | stale 판정 후 삭제 또는 건너뜀 |

---

## 10. 보안

- `.gitignore`: `.env`, `data/`, `logs/`, `node_modules/`, `content/published/`, `content/failed/`
- `.env.example`만 저장소에 포함. 단기 토큰은 setup 후 `.env`에서 제거.
- 로그·오류 출력에서 `access_token`, `client_secret` 값을 정규식으로 마스킹.
- `data/token.json`은 Windows 사용자 계정 권한으로만 접근(폴더 공유 금지). OneDrive 등 동기화 폴더에 두지 않는다.
- 앱 시크릿은 토큰 교환·갱신 요청 외에 어떤 API 호출에도 포함하지 않는다.

---

## 11. 테스트 전략

| 수준 | 대상 | 방법 |
|---|---|---|
| 단위 | validator, history(중복·상한), token(만료 계산), queueSource(파싱·정렬) | `node --test`, 파일시스템은 임시 폴더 사용 |
| 계약 | threadsClient | axios 어댑터를 모킹해 파라미터명(`reply_to_id`, `creation_id`)·오류 정규화 검증 |
| 통합 | `--dry-run` | 실제 API 호출 없이 전체 파이프라인 실행 |
| 실 API | `--now` 테스트 파일 1건 | 브랜드 계정에 테스트 글 발행 후 수동 삭제. 댓글이 원글 아래 달리는지 확인 |
| 운영 검증 | 7일 연속 스케줄 발행 | history.jsonl 성공률 확인 |

---

## 12. 구현 순서 (1차 MVP)

1. `config.js`, `logger.js`, `.env.example`, `.gitignore`
2. `threadsClient.js` (오류 정규화 포함) + 계약 테스트
3. `token.js` + `index.js --setup`, `--token-status`
4. `validator.js`, `history.js`, `queueSource.js` + 단위 테스트
5. `publisher.js` + `index.js --now`, `--dry-run`
6. 실 API 테스트 1건 (댓글 파라미터 확인)
7. `scheduler.js` + 락 + 일 상한 + Windows 작업 스케줄러 등록
8. README(설정 절차) 작성, 7일 운영 검증

---

## 13. 미결 사항

2026-09-08 기준 상태. 종결된 항목도 지우지 않고 결론을 남긴다.

| # | 항목 | 상태 | 결론 |
|---|---|---|---|
| 13-1 | 댓글 중간 실패 시 자동 이어쓰기 | **보류** | 착수 근거였던 `partial` 사고의 원인이 컨테이너 전파 지연이었고 ADR-014로 재시도 처리되어 사라졌다. 이력 구조를 복잡하게 만들 이유가 없다. **재착수 조건**: `partial`이 2건 이상 더 쌓이면 구현한다. |
| 13-2 | `link_attachment` 미리보기 카드 확인 | **미확인 (사람 확인 필요)** | 큐 파일 중 `link` 필드를 쓰는 것이 하나도 없어 이 코드 경로가 아직 한 번도 실행되지 않았다. 실계정 발행이 필요하므로 자동화하지 않는다. 절차는 README "링크 첨부 확인" 참조. |
| 13-3 | 알림 훅 채널 | **종결** | ADR-012로 확정. 채널을 코드에 박지 않고 `NOTIFY_WEBHOOK_URL` 웹훅 1개(`core/notify.js`)로 처리한다. |
| — | `reply_to_id` 파라미터 검증 (ADR-009) | **종결** | 2026-09-07 실 발행 2건에서 댓글 4개 체인이 모두 성공. `data/history.jsonl` 참조. |

### 13.1 알림 훅 (`core/notify.js`)

- `NOTIFY_WEBHOOK_URL`이 비어 있으면 아무것도 하지 않는다(기본값).
- 페이로드는 `{ text, content }`. Slack은 `text`, Discord는 `content`를 읽고 모르는 키는 무시한다. 채널별 어댑터를 두지 않는다.
- 전송 전 `logger.mask()`를 태운다 — 오류 메시지에 섞인 토큰이 외부로 나가지 않게.
- 알림 실패는 `logger.warn`으로 삼키고 `false`를 반환한다. 알림 때문에 발행이 실패하면 안 된다.
- 호출부는 두 곳뿐이다.
  1. `index.js` 발행 실패 catch — `partial`도 예외로 올라오므로 failed와 partial을 함께 덮는다. partial이면 이미 올라간 댓글 수를 본문에 넣는다.
  2. `core/token.js` 갱신 실패 + 잔여 2일 미만 — 무인 운영에서 조용히 죽는 유일한 경로.
- 성공 알림은 보내지 않는다. 매일 오는 알림은 곧 무시하게 되고, 성공은 `history.jsonl`에 남는다.
