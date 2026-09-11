'use strict';
// 절전 등으로 건너뛴 당일 회차를 기동 시 따라잡을지 판정한다 (순수 함수, 사이드이펙트 없음)

/**
 * cron 식이 "매일 같은 시각" 형태면 {hour, minute}을, 아니면 null을 반환한다.
 * 일반 cron 파서를 만들지 않는다 — 따라잡기는 일간 스케줄에서만 의미가 있고,
 * 그 외 형태(요일 지정, 분 단위 반복 등)는 판정을 포기하는 편이 안전하다.
 */
function dailyCronTime(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [m, h, dom, mon, dow] = f;
  if (dom !== '*' || mon !== '*' || dow !== '*') return null;
  if (!/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(h)) return null;
  const hour = Number(h);
  const minute = Number(m);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Date를 KST 벽시계로 본 시각(분 단위)으로 바꾼다. history.countToday와 같은 +9 규칙. */
function kstMinutes(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600000);
  return kst.getUTCHours() * 60 + kst.getUTCMinutes();
}

/**
 * 지금 따라잡아야 하는가?
 *
 * PC가 절전에 들어가면 node-cron 타이머가 멈추고, 깨어나도 지나간 시각을 소급 실행하지 않는다.
 * 그래서 기동 시점에 "오늘 예정 시각이 이미 지났는데 오늘 발행이 0건"이면 지금 한 건 올린다.
 *
 * **같은 날 안에서만 따라잡는다.** 다음 날 새벽에 부팅하면 그날 예정 시각은 아직 미래이므로
 * 따라잡지 않고 정규 회차에 맡긴다 — 도달이 없는 새벽에 글이 나가는 것을 막기 위해서다(ADR-017).
 *
 * 경계에서는 `>=`를 쓴다. 예정 시각과 같은 분에 기동하면 cron과 겹칠 수 있지만,
 * 중복은 락과 하루 상한이 막아준다. 한 회차를 통째로 놓치는 쪽이 더 나쁘다.
 *
 * @param {string} postCron  POST_CRON 값
 * @param {Date}   now       현재 시각
 * @param {number} todayCount 오늘(KST) 이미 발행된 건수
 */
function shouldCatchUp(postCron, now, todayCount) {
  const at = dailyCronTime(postCron);
  if (!at) return false;
  if (todayCount > 0) return false;
  return kstMinutes(now) >= at.hour * 60 + at.minute;
}

module.exports = { dailyCronTime, kstMinutes, shouldCatchUp };
