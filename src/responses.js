import { ProxyError } from './errors.js'

const REMOVED_CODEX_FIELDS = new Set([
  'generate',
  'max_completion_tokens',
  'max_output_tokens',
  'previous_response_id',
  'prompt_cache_options',
  'prompt_cache_retention',
  'safety_identifier',
  'stream_options',
  'temperature',
  'top_p',
  'truncation',
  'user',
])

export function normalizeResponsesRequest(payload, defaultModel) {
  const request = structuredClone(payload)
  const downstreamStream = request.stream === true
  request.model = typeof request.model === 'string' && request.model ? request.model : defaultModel

  if (typeof request.input === 'string') {
    request.input = [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: request.input }],
    }]
  }
  if (Array.isArray(request.input)) {
    for (const item of request.input) {
      if (item && typeof item === 'object' && item.role === 'system') item.role = 'developer'
    }
  }

  for (const field of REMOVED_CODEX_FIELDS) delete request[field]
  if (request.service_tier !== 'priority') delete request.service_tier

  request.stream = true
  request.store = false
  request.include = ['reasoning.encrypted_content']
  if (request.instructions == null) request.instructions = ''
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    request.parallel_tool_calls = true
  } else {
    delete request.parallel_tool_calls
  }
  return { request, downstreamStream }
}

export function parseSse(text) {
  const events = []
  let dataLines = []
  let eventNumber = 0

  const dispatch = () => {
    if (dataLines.length === 0) return
    const data = dataLines.join('\n')
    dataLines = []
    if (!data.trim() || data.trim() === '[DONE]') return
    eventNumber += 1

    let event
    try {
      event = JSON.parse(data)
    } catch (error) {
      throw new ProxyError(
        502,
        `Invalid JSON in upstream SSE event ${eventNumber}: ${error.message}`,
        'invalid_upstream_sse',
      )
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new ProxyError(502, `Upstream SSE event ${eventNumber} is not a JSON object`, 'invalid_upstream_sse')
    }
    events.push(event)
  }

  const source = text.startsWith('\uFEFF') ? text.slice(1) : text
  for (const line of source.split(/\r\n|\r|\n/)) {
    if (line === '') {
      dispatch()
      continue
    }
    if (line.startsWith(':')) continue

    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    if (field !== 'data') continue
    let value = separator === -1 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    dataLines.push(value)
  }
  dispatch()
  return events
}

export function terminalResponse(events) {
  const indexedItems = new Map()
  const fallbackItems = []
  let final
  let failure

  for (const event of events) {
    if (event.type === 'response.output_item.done' && event.item && typeof event.item === 'object') {
      if (Number.isInteger(event.output_index)) indexedItems.set(event.output_index, event.item)
      else fallbackItems.push(event.item)
    } else if (
      (event.type === 'response.completed' || event.type === 'response.incomplete')
      && event.response
      && typeof event.response === 'object'
    ) {
      final = event.response
    } else if (event.type === 'response.failed' || event.type === 'error') {
      failure = JSON.stringify(event.error || event)
    }
  }

  if (!final) {
    if (failure) throw new ProxyError(502, `Codex stream failed: ${failure}`, 'upstream_stream_failed')
    throw new ProxyError(502, 'Codex stream ended without a terminal response', 'incomplete_upstream_stream')
  }
  if ((!Array.isArray(final.output) || final.output.length === 0) && (indexedItems.size || fallbackItems.length)) {
    const ordered = [...indexedItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)
    final.output = [...ordered, ...fallbackItems]
  }
  return final
}
