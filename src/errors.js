export class ProxyError extends Error {
  constructor(status, message, code = 'proxy_error') {
    super(message)
    this.status = status
    this.code = code
  }
}

export class UpstreamHttpError extends Error {
  constructor(status, body, contentType) {
    super(`Codex upstream returned HTTP ${status}`)
    this.status = status
    this.body = body
    this.contentType = contentType
  }
}

export function networkErrorDetail(error) {
  const message = error instanceof Error ? error.message : String(error)
  const code = typeof error?.cause?.code === 'string' ? error.cause.code : ''
  return code && !message.includes(code) ? `${message} (${code})` : message
}
