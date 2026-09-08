# 미결 항목 정리 체크리스트 (2026-09-08)

TDD 13장 미결 3건 + ADR Pending 2건을 실제 코드·이력과 대조해 종결/구현/보류로 가른다.

## 조사

- [x] TDD 13장·ADR Pending 항목 열거
- [x] `data/history.jsonl`로 실 발행 결과 확인 (success 2건, 각 댓글 4개)
- [x] `content/queue/*.json` 전수 확인 — `link` 필드를 쓰는 파일 0개
- [x] 코드에서 알림 훅 흔적 확인 — 없음

## 종결 (문서만 수정)

- [x] ADR-009 `reply_to_id` "실 테스트로 확인 예정" → 2026-09-07 확인 완료로 갱신
- [x] ADR-014 신규 — error 100("does not exist") 전파 지연을 재시도 대상으로 본 결정 기록
- [x] TDD 13장을 "미결 3건" → 항목별 상태(종결/구현/보류)로 재작성

## 구현 — 알림 훅 (TDD 13-3 / ADR-012)

- [x] `core/notify.js` — 웹훅 POST 1회, URL 없으면 no-op, 실패해도 발행 흐름 유지
- [x] `config.js`에 `notifyWebhookUrl` 추가
- [x] `.env.example`에 `NOTIFY_WEBHOOK_URL` 추가
- [x] 호출부 1 — `index.js` 발행 실패/partial
- [x] 호출부 2 — `core/token.js` 갱신 실패 + 잔여 2일 미만
- [x] 테스트 — URL 없으면 전송하지 않고 false 반환
- [x] `npm test` 통과

## 보류 (기록만)

- [x] TDD 13-1 자동 이어쓰기 — 근본 원인(error 100)이 ADR-014로 해소되어 보류
- [x] TDD 13-2 `link_attachment` 실 테스트 — 실계정 발행이 필요해 운영자 확인 절차만 README에 명시
- [x] ADR-013 이미지 호스팅 — 확장 단계 항목, 그대로 Pending 유지

## 마무리

- [x] README / CLAUDE.md "아직 없는 것" 갱신
- [x] 커밋·푸시
