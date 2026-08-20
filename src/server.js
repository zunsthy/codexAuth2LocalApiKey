import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { readResponseBodyLimited } from './body.js'
import {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  MAX_NONSTREAM_SSE_BYTES,
  MAX_REQUEST_BYTES,
} from './constants.js'
import { NOOP_DEBUG } from './debug.js'
import { ProxyError, UpstreamHttpError } from './errors.js'
import { normalizeResponsesRequest, parseSse, terminalResponse } from './responses.js'

function sendJson(response, status, value) {
  if (response.destroyed || response.writableEnded) return
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    connection: 'close',
  })
  response.end(body)
}

function sendError(response, error) {
  sendJson(response, error.status || 500, {
    error: {
      message: error.message || 'Proxy failure',
      type: 'proxy_error',
      code: error.code || 'proxy_failure',
    },
  })
}

function authorized(request, response, apiKey) {
  if (!apiKey) return true
  const authorization = Array.isArray(request.headers.authorization)
    ? request.headers.authorization[0]
    : request.headers.authorization
  const actual = Buffer.from(authorization || '')
  const expected = Buffer.from(`Bearer ${apiKey}`)
  if (actual.length === expected.length && timingSafeEqual(actual, expected)) return true
  sendError(response, new ProxyError(401, 'Invalid local proxy API key', 'invalid_api_key'))
  return false
}

function requireApplicationJson(request) {
  const value = Array.isArray(request.headers['content-type'])
    ? request.headers['content-type'][0]
    : request.headers['content-type']
  const mediaType = String(value || '').split(';', 1)[0].trim().toLowerCase()
  if (mediaType !== 'application/json') {
    throw new ProxyError(415, 'Content-Type must be application/json', 'unsupported_media_type')
  }
}

function observeClientDisconnect(request, response, debug, requestId) {
  const controller = new AbortController()
  const abort = source => {
    if (controller.signal.aborted) return
    debug('client.disconnected', { requestId, source })
    controller.abort(new DOMException('Client disconnected', 'AbortError'))
  }
  const onAborted = () => abort('request.aborted')
  const onRequestClose = () => {
    if (request.aborted || !request.complete) abort('request.close')
  }
  const onResponseClose = () => {
    if (!response.writableEnded) abort('response.close')
  }

  request.once('aborted', onAborted)
  request.once('close', onRequestClose)
  response.once('close', onResponseClose)
  return {
    signal: controller.signal,
    cleanup() {
      request.off('aborted', onAborted)
      request.off('close', onRequestClose)
      response.off('close', onResponseClose)
    },
  }
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) {
      throw new ProxyError(413, 'Request body is too large', 'invalid_request')
    }
    chunks.push(chunk)
  }
  if (size === 0) throw new ProxyError(400, 'Request body is empty', 'invalid_request')

  let payload
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    throw new ProxyError(400, `Invalid JSON: ${error.message}`, 'invalid_json')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProxyError(400, 'Request body must be a JSON object', 'invalid_request')
  }
  if (!Object.hasOwn(payload, 'input')) throw new ProxyError(400, 'Missing `input`', 'invalid_request')
  return payload
}

export function createProxyServer({
  backend,
  model,
  apiKey = '',
  unsafeNoAuth = false,
  upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
  debug = NOOP_DEBUG,
}) {
  if (!apiKey && !unsafeNoAuth) {
    throw new Error('A local API key is required unless --unsafe-no-auth is explicitly enabled')
  }

  return createHttpServer(async (request, response) => {
    const requestId = randomUUID()
    let disconnect
    let timeoutSignal

    try {
      const pathname = new URL(request.url || '/', 'http://localhost').pathname
      debug('request.start', { requestId, method: request.method, pathname })
      if (!authorized(request, response, apiKey)) {
        debug('request.rejected', { requestId, reason: 'invalid_api_key' })
        return
      }
      if (request.method === 'GET' && pathname === '/healthz') {
        sendJson(response, 200, { ok: true })
        return
      }
      if (request.method === 'GET' && pathname === '/v1/models') {
        sendJson(response, 200, {
          object: 'list',
          data: [{ id: model, object: 'model', created: 0, owned_by: 'openai-codex' }],
        })
        return
      }
      if (request.method !== 'POST' || pathname !== '/v1/responses') {
        throw new ProxyError(404, 'Only POST /v1/responses is implemented', 'not_found')
      }
      requireApplicationJson(request)
      disconnect = observeClientDisconnect(request, response, debug, requestId)

      const payload = await readJson(request)
      const { request: normalized, downstreamStream } = normalizeResponsesRequest(payload, model)
      timeoutSignal = AbortSignal.timeout(upstreamTimeoutMs)
      const signal = AbortSignal.any([disconnect.signal, timeoutSignal])
      const upstream = await backend.open(normalized, { signal, requestId })

      if (downstreamStream) {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'close',
        })
        if (!upstream.body) {
          response.end()
          return
        }
        await pipeline(Readable.fromWeb(upstream.body), response, { signal })
        debug('request.complete', { requestId, mode: 'stream' })
        return
      }

      const sseBody = await readResponseBodyLimited(
        upstream,
        MAX_NONSTREAM_SSE_BYTES,
        'Codex non-streaming SSE body',
      )
      const final = terminalResponse(parseSse(sseBody.toString('utf8')))
      sendJson(response, 200, final)
      debug('request.complete', { requestId, mode: 'nonstream', upstreamBytes: sseBody.length })
    } catch (error) {
      if (disconnect?.signal.aborted) {
        debug('request.cancelled', { requestId })
      } else if (timeoutSignal?.aborted) {
        const timeoutError = new ProxyError(
          504,
          `Codex upstream timed out after ${upstreamTimeoutMs}ms`,
          'upstream_timeout',
        )
        debug('request.timeout', { requestId, timeoutMs: upstreamTimeoutMs })
        if (response.headersSent) response.destroy(timeoutError)
        else sendError(response, timeoutError)
      } else if (response.destroyed) {
        debug('request.cancelled', { requestId, reason: 'response_destroyed' })
      } else if (response.headersSent) {
        response.destroy(error)
      } else if (error instanceof UpstreamHttpError) {
        debug('request.upstream_error', { requestId, status: error.status })
        response.writeHead(error.status, {
          'content-type': error.contentType,
          'content-length': error.body.length,
          connection: 'close',
        })
        response.end(error.body)
      } else {
        debug('request.error', {
          requestId,
          status: error.status || 500,
          code: error.code || 'proxy_failure',
        })
        sendError(response, error)
      }
    } finally {
      disconnect?.cleanup()
    }
  })
}
