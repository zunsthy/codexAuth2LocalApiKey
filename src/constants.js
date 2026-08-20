export const TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const OPENAI_AUTH_CLAIM_URL = 'https://api.openai.com/auth'
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const DEFAULT_UPSTREAM = 'https://chatgpt.com/backend-api/codex/responses'
export const DEFAULT_MODEL = 'gpt-5.6-sol'
export const DEFAULT_USER_AGENT = 'codex_cli_rs/0.1.0 (codex-auth-to-local-api-key)'
export const DEFAULT_PORT = 10680
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 300_000

export const MAX_REQUEST_BYTES = 16 * 1024 * 1024
export const MAX_UPSTREAM_ERROR_BYTES = 1024 * 1024
export const MAX_NONSTREAM_SSE_BYTES = 16 * 1024 * 1024
export const REFRESH_SKEW_SECONDS = 120
