// v3 follow-up (admin-invite / password-reset auth flow): builds the base
// URL embedded in emailed links. FRONTEND_URL isn't set anywhere else in
// this app (CORS_ORIGIN is a comma-separated allowlist, not a single
// canonical URL to embed in an email), so this is a new env var — falls
// back to the first CORS_ORIGIN entry if unset, so a deployment that
// hasn't added it yet still produces a best-effort link instead of hard
// failing the invite/reset request.
export function frontendUrl(): string {
  const { env } = process
  const { FRONTEND_URL: url, CORS_ORIGIN: corsOrigin } = env
  if (url !== undefined && url !== '') return url
  const [firstOrigin] = (corsOrigin ?? '').split(',')
  return firstOrigin !== undefined && firstOrigin !== '' ? firstOrigin : 'http://localhost:3000'
}
