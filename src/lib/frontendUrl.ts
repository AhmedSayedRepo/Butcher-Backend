const TRAILING_SLASHES = /\/+$/v

// v3 follow-up (admin-invite / password-reset auth flow): builds the base
// URL embedded in emailed links. FRONTEND_URL isn't set anywhere else in
// this app (CORS_ORIGIN is a comma-separated allowlist, not a single
// canonical URL to embed in an email), so this is a new env var — falls
// back to the first CORS_ORIGIN entry if unset, so a deployment that
// hasn't added it yet still produces a best-effort link instead of hard
// failing the invite/reset request.
//
// v3.1 bug fix: every caller does `${frontendUrl()}/set-password?...` —
// if whoever set FRONTEND_URL on Render included a trailing slash (an easy
// thing to do, and a value that's still a perfectly valid URL on its own),
// that produced a double slash (".../app//set-password") in the emailed/
// displayed link. Stripping trailing slashes here means callers can always
// safely append "/path" with no defensive trimming of their own.
export function frontendUrl(): string {
  const { env } = process
  const { FRONTEND_URL: url, CORS_ORIGIN: corsOrigin } = env
  if (url !== undefined && url !== '') return url.replace(TRAILING_SLASHES, '')
  // `''.split(',')` still returns `['']`, never `[]` — `firstOrigin` is
  // always a string here, never `undefined`, so only the empty-string case
  // needs checking (an explicit `!== undefined` alongside it is what
  // @typescript-eslint/no-unnecessary-condition was flagging).
  const [firstOrigin] = (corsOrigin ?? '').split(',')
  return firstOrigin === '' ? 'http://localhost:3000' : firstOrigin.replace(TRAILING_SLASHES, '')
}
