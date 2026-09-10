'use strict';
const config = require('../config');

/**
 * ContentItem을 검증한다.
 * @returns {{ok: boolean, errors: string[]}}
 */
function validate(item, { maxLength = config.maxTextLength, bannedWords = config.bannedWords } = {}) {
  const errors = [];

  if (!item || typeof item !== 'object') {
    return { ok: false, errors: ['항목이 객체가 아닙니다'] };
  }
  if (typeof item.text !== 'string' || item.text.trim() === '') {
    errors.push('text가 비어 있습니다');
  } else if (item.text.length > maxLength) {
    errors.push(`text가 ${maxLength}자를 넘습니다 (${item.text.length}자)`);
  }

  const replies = item.replies === undefined ? [] : item.replies;
  if (!Array.isArray(replies)) {
    errors.push('replies는 배열이어야 합니다');
  } else {
    replies.forEach((r, i) => {
      if (typeof r !== 'string' || r.trim() === '') errors.push(`replies[${i}]가 비어 있습니다`);
      else if (r.length > maxLength) errors.push(`replies[${i}]가 ${maxLength}자를 넘습니다 (${r.length}자)`);
    });
  }

  if (item.link !== undefined && !/^https?:\/\//i.test(String(item.link))) {
    errors.push('link는 http(s) URL이어야 합니다');
  }
  if (item.publishAt !== undefined && Number.isNaN(new Date(item.publishAt).getTime())) {
    errors.push('publishAt이 올바른 날짜가 아닙니다');
  }

  if (bannedWords.length) {
    const all = [item.text || '', ...(Array.isArray(replies) ? replies : [])].join('\n');
    for (const w of bannedWords) {
      if (w && all.includes(w)) errors.push(`금칙어 포함: "${w}"`);
    }
  }

  // 검증을 통과한 항목은 replies가 반드시 배열임을 보장한다.
  // publisher가 item.replies.length를 바로 읽으므로, 계약을 여기서 확정지어
  // 호출부마다 방어코드를 까는 것을 막는다.
  if (errors.length === 0 && item.replies === undefined) item.replies = [];

  return { ok: errors.length === 0, errors };
}

module.exports = { validate };
