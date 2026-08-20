import { readResponseBodyLimited } from './body.js'
import {
  DEFAULT_UPSTREAM,
  DEFAULT_USER_AGENT,
  MAX_UPSTREAM_ERROR_BYTES,
} from './constants.js'
import { NOOP_DEBUG } from './debug.js'
import { networkErrorDetail, ProxyError, UpstreamHttpError } from './errors.js'

export class CodexBackend {
  constructor(
    credentials,
    upstreamUrl = DEFAULT_UPSTREAM,
    userAgent = DEFAULT_USER_AGENT,
    fetchImpl = globalThis.fetch,
    debug = NOOP_DEBUG,
  ) {
    this.credentials = credentials
    this.upstreamUrl = upstreamUrl
    this.userAgent = userAgent
    this.fetchImpl = fetchImpl
    this.debug = debug
  }

  async open(payload, { signal, requestId } = {}) {
    const body = JSON.stringify(payload)
    let attempt = await this.openOnce(body, '', signal, requestId, 1)
    if (attempt.response.status === 401) {
      this.debug('upstream.retry', { requestId, reason: '401' })
      await attempt.response.body?.cancel().catch(() => {})
      attempt = await this.openOnce(body, attempt.accessToken, signal, requestId, 2)
    }

    const { response } = attempt
    if (!response.ok) {
      const contentType = response.headers.get('content-type') || 'application/json'
      const errorBody = await readResponseBodyLimited(
        response,
        MAX_UPSTREAM_ERROR_BYTES,
        'Codex upstream error body',
      )
      throw new UpstreamHttpError(response.status, errorBody, contentType)
    }
    return response
  }

  async openOnce(body, rejectedAccessToken, signal, requestId, attempt) {
    const { accessToken, accountId } = await this.credentials.token(rejectedAccessToken)
    const headers = {
      accept: 'text/event-stream',
      'accept-encoding': 'identity',
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      originator: 'codex_cli_rs',
      'user-agent': this.userAgent,
    }
    if (accountId) headers['chatgpt-account-id'] = accountId
    this.debug('upstream.request.start', { requestId, attempt })

    try {
      const response = await this.fetchImpl(this.upstreamUrl, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal,
      })
      this.debug('upstream.request.headers', { requestId, attempt, status: response.status })
      return { response, accessToken }
    } catch (error) {
      if (signal?.aborted) throw error
      throw new ProxyError(502, `Cannot reach Codex upstream: ${networkErrorDetail(error)}`, 'upstream_unavailable')
    }
  }
}
