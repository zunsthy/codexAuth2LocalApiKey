import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { readResponseBodyLimited } from './body.js'
import {
  CODEX_CLIENT_ID,
  MAX_UPSTREAM_ERROR_BYTES,
  OPENAI_AUTH_CLAIM_URL,
  REFRESH_SKEW_SECONDS,
  TOKEN_URL,
} from './constants.js'
import { NOOP_DEBUG } from './debug.js'
import { networkErrorDetail, ProxyError } from './errors.js'

export function jwtClaims(token) {
  const parts = token.split('.')
  if (parts.length !== 3) return {}
  try {
    const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

export function accountIdFromIdToken(idToken) {
  const auth = jwtClaims(idToken)[OPENAI_AUTH_CLAIM_URL]
  const value = auth && typeof auth === 'object' ? auth.chatgpt_account_id : ''
  return typeof value === 'string' ? value.trim() : ''
}

function tokenExpiry(accessToken) {
  const value = jwtClaims(accessToken).exp
  return Number.isInteger(value) ? value : 0
}

function oauthErrorDetail(text) {
  try {
    const body = JSON.parse(text)
    let value = body?.error
    if (value && typeof value === 'object') value = value.code ?? value.message
    if (typeof value !== 'string') value = body?.code ?? body?.error_description
    return typeof value === 'string' ? value.slice(0, 200) : ''
  } catch {
    return ''
  }
}

function stringValue(object, key) {
  const value = object?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

export class CredentialStore {
  constructor(path, fetchImpl = globalThis.fetch, debug = NOOP_DEBUG) {
    this.path = path
    this.fetchImpl = fetchImpl
    this.debug = debug
    this.queue = Promise.resolve()
  }

  token(rejectedAccessToken = '') {
    const operation = this.queue.then(
      () => this.tokenLocked(rejectedAccessToken),
      () => this.tokenLocked(rejectedAccessToken),
    )
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  async tokenLocked(rejectedAccessToken) {
    const document = await this.load()
    const tokens = document.tokens && typeof document.tokens === 'object'
      ? document.tokens
      : document

    let accessToken = stringValue(tokens, 'access_token')
    const refreshToken = stringValue(tokens, 'refresh_token')
    const expiresAt = tokenExpiry(accessToken)
    const diskTokenChanged = Boolean(
      rejectedAccessToken
      && accessToken
      && accessToken !== rejectedAccessToken,
    )
    const shouldRefresh = !diskTokenChanged && (
      Boolean(rejectedAccessToken)
      || !accessToken
      || (expiresAt !== 0 && expiresAt <= Math.floor(Date.now() / 1000) + REFRESH_SKEW_SECONDS)
    )

    if (diskTokenChanged) {
      this.debug('token.refresh.skipped', { reason: 'credential_file_has_newer_access_token' })
    }

    if (shouldRefresh) {
      if (!refreshToken) {
        throw new ProxyError(
          401,
          'Codex credentials are expired and contain no refresh token; run `codex login` again',
          'codex_login_required',
        )
      }
      this.debug('token.refresh.start', {
        reason: rejectedAccessToken ? 'upstream_401' : accessToken ? 'expiring' : 'missing',
      })
      const refreshed = await this.refresh(refreshToken)
      tokens.access_token = refreshed.access_token
      tokens.refresh_token = refreshed.refresh_token || refreshToken
      if (typeof refreshed.id_token === 'string' && refreshed.id_token) {
        tokens.id_token = refreshed.id_token
      }
      const refreshedAccountId = accountIdFromIdToken(stringValue(tokens, 'id_token'))
      if (refreshedAccountId) tokens.account_id = refreshedAccountId
      document.last_refresh = new Date().toISOString()
      await this.save(document)
      accessToken = stringValue(tokens, 'access_token')
      this.debug('token.refresh.complete')
    }

    if (!accessToken) {
      throw new ProxyError(
        401,
        'No ChatGPT OAuth token found; run `codex login` with ChatGPT authentication',
        'codex_login_required',
      )
    }

    const accountId = stringValue(tokens, 'account_id')
      || accountIdFromIdToken(stringValue(tokens, 'id_token'))
    return { accessToken, accountId }
  }

  async load() {
    let text
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new ProxyError(
          401,
          `Codex credential file not found at ${this.path}; run \`codex login\` first`,
          'codex_login_required',
        )
      }
      throw new ProxyError(500, `Cannot read Codex credential file: ${error.message}`, 'credential_error')
    }
    try {
      const document = JSON.parse(text)
      if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('expected an object')
      return document
    } catch (error) {
      throw new ProxyError(500, `Cannot parse Codex credential file: ${error.message}`, 'credential_error')
    }
  }

  async refresh(refreshToken) {
    let response
    try {
      response = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: CODEX_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      throw new ProxyError(502, `Codex token refresh failed: ${networkErrorDetail(error)}`, 'token_refresh_failed')
    }

    const responseBody = await readResponseBodyLimited(
      response,
      MAX_UPSTREAM_ERROR_BYTES,
      response.ok ? 'Codex token refresh response' : 'Codex token refresh error body',
    )
    const responseText = responseBody.toString('utf8')
    if (!response.ok) {
      const detail = oauthErrorDetail(responseText)
      throw new ProxyError(
        401,
        `Codex token refresh failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
        'token_refresh_failed',
      )
    }

    let payload
    try {
      payload = JSON.parse(responseText)
    } catch {
      throw new ProxyError(502, 'Codex token refresh returned invalid JSON', 'token_refresh_failed')
    }
    if (!payload || typeof payload.access_token !== 'string' || !payload.access_token) {
      throw new ProxyError(502, 'Codex token refresh returned no access token', 'token_refresh_failed')
    }
    return payload
  }

  async save(document) {
    const parent = dirname(this.path)
    const temporary = join(parent, `.auth.${process.pid}.${randomUUID()}.tmp`)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    let handle
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await chmod(temporary, 0o600)
      await rename(temporary, this.path)
    } catch (error) {
      await handle?.close().catch(() => {})
      await unlink(temporary).catch(() => {})
      throw new ProxyError(500, `Cannot persist refreshed Codex credentials: ${error.message}`, 'credential_error')
    }
  }
}
