'use strict';
const axios = require('axios');
const config = require('../config');
const logger = require('./logger');

const BASE_URL = 'https://graph.threads.net';

/** Threads API 오류를 한 가지 모양으로 정규화한다. */
class ThreadsApiError extends Error {
  constructor({ code, subcode, message, isRetryable, isAuthError, status }) {
    super(message);
    this.name = 'ThreadsApiError';
    this.code = code ?? null;
    this.subcode = subcode ?? null;
    this.status = status ?? null;
    this.isRetryable = !!isRetryable;
    this.isAuthError = !!isAuthError;
  }
}

// 레이트 리밋 계열 오류 코드 (TDD 9장)
const RETRYABLE_CODES = new Set([4, 17, 32]);

function normalizeError(err) {
  // 네트워크 오류 (응답 자체가 없음)
  if (!err.response) {
    return new ThreadsApiError({
      message: `네트워크 오류: ${err.message}`,
      isRetryable: true,
      isAuthError: false,
    });
  }
  const status = err.response.status;
  const body = err.response.data || {};
  const e = body.error || {};
  const code = e.code;
  const subcode = e.error_subcode;
  const message = e.message || `HTTP ${status}`;

  const isAuthError = status === 401 || status === 403 || code === 190;
  // 메인 발행 직후 그 글 id를 reply_to_id로 쓰면 전파 지연으로 "does not exist"가 간헐적으로 난다.
  // 고정 대기로는 못 잡는 타이밍 이슈라 재시도 대상에 포함한다 (백오프 2s→4s→8s).
  // ponytail: 영문 메시지 매칭. 재시도로도 안 되면 REPLY_DELAY_MS/PUBLISH_RETRY를 올린다.
  const isTransientNotFound = code === 100 && /does not exist/i.test(message);
  const isRetryable =
    !isAuthError &&
    (status === 429 || status >= 500 || RETRYABLE_CODES.has(code) || isTransientNotFound);

  return new ThreadsApiError({ code, subcode, message, isRetryable, isAuthError, status });
}

class ThreadsClient {
  constructor({ accessToken, userId, apiVersion } = {}) {
    this.accessToken = accessToken;
    this.userId = userId;
    this.apiVersion = apiVersion || config.apiVersion;
    this.http = axios.create({ baseURL: BASE_URL, timeout: config.httpTimeoutMs });
  }

  async _get(url, params = {}) {
    try {
      const res = await this.http.get(url, {
        params: { access_token: this.accessToken, ...params },
      });
      return res.data;
    } catch (err) {
      throw normalizeError(err);
    }
  }

  async _post(url, params = {}) {
    try {
      // Threads API는 POST도 쿼리스트링 파라미터를 받는다.
      const res = await this.http.post(url, null, {
        params: { access_token: this.accessToken, ...params },
      });
      return res.data;
    } catch (err) {
      throw normalizeError(err);
    }
  }

  /** 단기 토큰 → 장기 토큰 교환. 이 호출에만 app secret을 쓴다. */
  async exchangeLongLivedToken(shortToken, appSecret) {
    try {
      const res = await this.http.get('/access_token', {
        params: {
          grant_type: 'th_exchange_token',
          client_secret: appSecret,
          access_token: shortToken,
        },
      });
      return res.data; // { access_token, token_type, expires_in }
    } catch (err) {
      throw normalizeError(err);
    }
  }

  /**
   * 인증 코드 → 단기 토큰. 이 호출은 폼 바디를 쓴다(다른 호출은 쿼리스트링).
   * redirect_uri는 Meta 앱에 등록된 값과 문자 그대로 같아야 한다.
   */
  async exchangeAuthCode({ code, appId, appSecret, redirectUri }) {
    try {
      const res = await this.http.post(
        '/oauth/access_token',
        new URLSearchParams({
          client_id: appId,
          client_secret: appSecret,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code: String(code).replace(/#_$/, ''), // 리디렉트 URL 끝에 붙는 조각 제거
        })
      );
      return res.data; // { access_token, user_id }
    } catch (err) {
      throw normalizeError(err);
    }
  }

  /** 장기 토큰 갱신. */
  async refreshLongLivedToken() {
    return this._get('/refresh_access_token', { grant_type: 'th_refresh_token' });
  }

  async getMe() {
    return this._get(`/${this.apiVersion}/me`, { fields: 'id,username' });
  }

  /**
   * 텍스트 컨테이너 생성.
   * 댓글 파라미터는 reply_to_id 다 (가이드 코드의 reply_to_thread_key 아님 — TDD 4.1 주의사항).
   */
  async createTextContainer({ text, replyToId, linkAttachment }) {
    const params = { media_type: 'TEXT', text };
    if (replyToId) params.reply_to_id = replyToId;
    if (linkAttachment) params.link_attachment = linkAttachment;
    const data = await this._post(`/${this.apiVersion}/${this.userId}/threads`, params);
    if (!data || !data.id) throw new ThreadsApiError({ message: '컨테이너 ID가 응답에 없습니다' });
    return data.id;
  }

  async getContainerStatus(containerId) {
    const data = await this._get(`/${this.apiVersion}/${containerId}`, {
      fields: 'status,error_message',
    });
    return { status: data.status, errorMessage: data.error_message || null };
  }

  async publish(containerId) {
    const data = await this._post(`/${this.apiVersion}/${this.userId}/threads_publish`, {
      creation_id: containerId,
    });
    if (!data || !data.id) throw new ThreadsApiError({ message: '발행 ID가 응답에 없습니다' });
    return data.id;
  }

  async getPublishingLimit() {
    return this._get(`/${this.apiVersion}/${this.userId}/threads_publishing_limit`, {
      fields: 'quota_usage,config,reply_quota_usage,reply_config',
    });
  }

  /**
   * 컨테이너가 FINISHED가 될 때까지 기다린다.
   * 고정 대기 대신 상태를 확인한다 (TDD 4.3).
   */
  async waitUntilFinished(containerId) {
    for (let i = 0; i < config.containerPollMaxTries; i++) {
      const { status, errorMessage } = await this.getContainerStatus(containerId);
      if (status === 'FINISHED' || status === 'PUBLISHED') return status;
      if (status === 'ERROR' || status === 'EXPIRED') {
        throw new ThreadsApiError({
          message: `컨테이너 ${status}: ${errorMessage || '사유 없음'}`,
          isRetryable: false,
        });
      }
      logger.debug(`컨테이너 ${containerId} 상태 ${status}, 재조회 ${i + 1}/${config.containerPollMaxTries}`);
      await new Promise((r) => setTimeout(r, config.containerPollIntervalMs));
    }
    throw new ThreadsApiError({
      message: `컨테이너 ${containerId}가 ${config.containerPollMaxTries}회 조회 후에도 FINISHED가 아님`,
      isRetryable: true,
    });
  }
}

module.exports = { ThreadsClient, ThreadsApiError, normalizeError, BASE_URL };
