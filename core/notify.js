'use strict';
// 발행 실패·토큰 만료 임박을 외부 웹훅으로 알리는 모듈 (URL이 없으면 아무것도 하지 않는다)
const axios = require('axios');
const config = require('../config');
const logger = require('./logger');

/**
 * 웹훅으로 한 줄 알림을 보낸다.
 * Slack은 text, Discord는 content를 읽고 서로 모르는 키는 무시하므로 둘 다 담는다.
 * 알림 실패가 발행을 막아서는 안 되므로 오류는 삼키고 false를 반환한다.
 * @returns {Promise<boolean>} 전송했으면 true
 */
async function send(text) {
  if (!config.notifyWebhookUrl) return false;
  const body = logger.mask(text); // 오류 메시지에 토큰이 섞여 나가지 않도록
  try {
    await axios.post(
      config.notifyWebhookUrl,
      { text: body, content: body },
      { timeout: config.httpTimeoutMs }
    );
    return true;
  } catch (err) {
    logger.warn(`알림 전송 실패: ${err.message}`);
    return false;
  }
}

module.exports = { send };
