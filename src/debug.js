import createDebug from 'debug'

export const NOOP_DEBUG = () => {}

export function createDebugLogger(forceEnabled = false) {
  const logger = createDebug('codex-auth-to-local-api-key')
  if (forceEnabled) logger.enabled = true

  return (event, details = {}) => {
    if (Object.keys(details).length > 0) logger('%s %O', event, details)
    else logger('%s', event)
  }
}
