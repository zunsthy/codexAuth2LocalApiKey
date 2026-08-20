#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { CodexBackend } from './src/backend.js'
import {
  configureUpstreamProxy,
  parseArgs,
  usage,
  validateOptions,
} from './src/config.js'
import { CredentialStore } from './src/credentials.js'
import { createDebugLogger } from './src/debug.js'
import { createProxyServer } from './src/server.js'

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(usage())
    return
  }

  validateOptions(options)
  const debug = createDebugLogger(options.debug)
  const proxy = configureUpstreamProxy(options.proxyUrl)
  const credentials = new CredentialStore(options.authFile, globalThis.fetch, debug)
  const backend = new CodexBackend(
    credentials,
    options.upstream,
    options.userAgent,
    globalThis.fetch,
    debug,
  )
  const server = createProxyServer({
    backend,
    model: options.model.trim(),
    apiKey: options.apiKey,
    unsafeNoAuth: options.unsafeNoAuth,
    upstreamTimeoutMs: options.upstreamTimeoutMs,
    debug,
  })

  debug('server.listen.start', {
    host: options.host,
    port: options.port,
    model: options.model.trim(),
    upstreamTimeoutMs: options.upstreamTimeoutMs,
    proxy: proxy.description,
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, resolveListen)
  })
  debug('server.listen.ready', { host: options.host, port: options.port })

  console.log(`codex-auth-to-local-api-key listening on http://${options.host}:${options.port}/v1`)
  console.log(`credential file: ${options.authFile}`)
  console.log(`model: ${options.model.trim()}`)
  console.log(`upstream proxy: ${proxy.description}`)
  console.log(`upstream timeout: ${options.upstreamTimeoutMs}ms`)
  if (options.unsafeNoAuth) console.error('WARNING: local API authentication is disabled by --unsafe-no-auth')
  return server
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isEntryPoint) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
