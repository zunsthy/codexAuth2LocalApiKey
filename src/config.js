import { setGlobalProxyFromEnv } from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  DEFAULT_MODEL,
  DEFAULT_PORT,
  DEFAULT_UPSTREAM,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
} from './constants.js'

export function defaultAuthFile(env = process.env) {
  return join(env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')
}

function loopbackNoProxy(value = '') {
  const entries = value.split(',').map(entry => entry.trim()).filter(Boolean)
  for (const entry of ['localhost', '127.0.0.1', '::1']) {
    if (!entries.includes(entry)) entries.push(entry)
  }
  return entries.join(',')
}

function redactedProxyUrl(value) {
  const url = new URL(value)
  url.username = url.username ? '***' : ''
  url.password = url.password ? '***' : ''
  return url.toString()
}

export function proxyEnvironment(value, env = process.env) {
  const configured = String(value || '').trim()
  if (configured.toLowerCase() === 'direct' || configured.toLowerCase() === 'none') {
    return { mode: 'direct', description: 'direct', proxyEnv: null }
  }

  if (!configured || configured.toLowerCase() === 'env') {
    const httpProxy = env.HTTP_PROXY || env.http_proxy || ''
    const httpsProxy = env.HTTPS_PROXY || env.https_proxy || httpProxy
    if (!httpProxy && !httpsProxy) {
      return { mode: 'direct', description: 'direct (no proxy environment found)', proxyEnv: null }
    }
    return {
      mode: 'environment',
      description: 'environment',
      proxyEnv: {
        HTTP_PROXY: httpProxy,
        HTTPS_PROXY: httpsProxy,
        NO_PROXY: loopbackNoProxy(env.NO_PROXY || env.no_proxy || ''),
      },
    }
  }

  let url
  try {
    url = new URL(configured)
  } catch {
    throw new Error('--proxy-url must be `env`, `direct`, or an absolute HTTP(S) proxy URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('--proxy-url currently supports only http:// and https:// proxy URLs')
  }
  if (url.hash || configured.includes('#')) {
    throw new Error('--proxy-url must not contain a URL fragment')
  }
  return {
    mode: 'explicit',
    description: redactedProxyUrl(url.toString()),
    proxyEnv: {
      HTTP_PROXY: url.toString(),
      HTTPS_PROXY: url.toString(),
      NO_PROXY: loopbackNoProxy(env.NO_PROXY || env.no_proxy || ''),
    },
  }
}

export function configureUpstreamProxy(value, env = process.env) {
  const setting = proxyEnvironment(value, env)
  if (setting.proxyEnv) setGlobalProxyFromEnv(setting.proxyEnv)
  return setting
}

export function validateUpstreamUrl(value) {
  const url = new URL(value)
  if (url.username || url.password) {
    throw new Error('--upstream must not contain embedded credentials')
  }
  if (url.hash || String(value).includes('#')) {
    throw new Error('--upstream must not contain a URL fragment')
  }
  if (url.protocol !== 'https:') {
    throw new Error('--upstream must be an absolute HTTPS URL')
  }
}

function expandHome(path) {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

export function usage() {
  return `Usage: node index.js [options]

Options:
  --host HOST          Listen address (default: 127.0.0.1)
  --port PORT          Listen port (default: ${DEFAULT_PORT})
  --model MODEL        Model exposed by /v1/models (default: ${DEFAULT_MODEL})
  --auth-file PATH     Codex auth.json path (default: ~/.codex/auth.json)
  --api-key KEY        Required local proxy bearer token
  --unsafe-no-auth     Explicitly allow unauthenticated local requests
  --proxy-url URL      Upstream proxy: env, direct, or http(s)://host:port
  --upstream URL       Codex Responses upstream
  --upstream-timeout-ms MS
                       Overall upstream timeout (default: ${DEFAULT_UPSTREAM_TIMEOUT_MS})
  --user-agent VALUE   Upstream User-Agent
  --debug              Enable codex-auth-to-local-api-key debug logs
  -h, --help           Show this help
`
}

export function parseArgs(argv, env = process.env) {
  const options = {
    host: env.MINI_CODEX_HOST || '127.0.0.1',
    port: Number(env.MINI_CODEX_PORT || DEFAULT_PORT),
    model: env.MINI_CODEX_MODEL || DEFAULT_MODEL,
    authFile: env.CODEX_AUTH_FILE || defaultAuthFile(env),
    apiKey: env.MINI_CODEX_API_KEY || '',
    unsafeNoAuth: false,
    proxyUrl: env.MINI_CODEX_PROXY_URL || '',
    upstream: env.CODEX_UPSTREAM_URL || DEFAULT_UPSTREAM,
    upstreamTimeoutMs: Number(env.MINI_CODEX_UPSTREAM_TIMEOUT_MS || DEFAULT_UPSTREAM_TIMEOUT_MS),
    userAgent: env.CODEX_USER_AGENT || DEFAULT_USER_AGENT,
    debug: /^(1|true|yes|on)$/i.test(env.MINI_CODEX_DEBUG || ''),
  }
  const names = new Map([
    ['--host', 'host'], ['--port', 'port'], ['--model', 'model'], ['--auth-file', 'authFile'],
    ['--api-key', 'apiKey'], ['--proxy-url', 'proxyUrl'], ['--upstream', 'upstream'],
    ['--upstream-timeout-ms', 'upstreamTimeoutMs'],
    ['--user-agent', 'userAgent'],
  ])

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') return { help: true }
    if (argument === '--unsafe-no-auth') {
      options.unsafeNoAuth = true
      continue
    }
    if (argument === '--debug') {
      options.debug = true
      continue
    }
    const name = names.get(argument)
    if (!name || index + 1 >= argv.length) throw new Error(`Unknown or incomplete option: ${argument}`)
    options[name] = ['port', 'upstreamTimeoutMs'].includes(name) ? Number(argv[++index]) : argv[++index]
  }
  options.authFile = resolve(expandHome(options.authFile))
  return options
}

export function validateOptions(options) {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('Invalid --port')
  }
  if (
    !Number.isInteger(options.upstreamTimeoutMs)
    || options.upstreamTimeoutMs < 1
    || options.upstreamTimeoutMs > 2_147_483_647
  ) {
    throw new Error('Invalid --upstream-timeout-ms')
  }
  if (!options.model.trim()) throw new Error('--model must not be empty')
  if (!options.apiKey.trim() && !options.unsafeNoAuth) {
    throw new Error('Missing --api-key; use --unsafe-no-auth only for an intentionally unauthenticated server')
  }
  validateUpstreamUrl(options.upstream)
}
