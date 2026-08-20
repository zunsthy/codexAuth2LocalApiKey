import { ProxyError } from './errors.js'

export async function readResponseBodyLimited(response, maxBytes, label) {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new ProxyError(502, `${label} exceeds the ${maxBytes}-byte limit`, 'upstream_body_too_large')
  }
  if (!response.body) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new ProxyError(502, `${label} exceeds the ${maxBytes}-byte limit`, 'upstream_body_too_large')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}
