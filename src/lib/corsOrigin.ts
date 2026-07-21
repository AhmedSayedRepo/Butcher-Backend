// Multi-tenancy phase 3 — CORS across per-organization subdomains
// (Butcher-Multi-Tenancy-Plan.md §3).
//
// Before this, `CORS_ORIGIN` was a comma-separated list of exact origins. With
// a subdomain per shop that list would need editing every time a customer is
// onboarded — which means it would eventually be wrong, and a wrong CORS list
// looks like "the app is broken for this one customer".
//
// `CORS_WILDCARD_DOMAIN=butchercashier.com` allows `https://<sub>.butchercashier.com`
// for any single-label subdomain, with no per-customer configuration.
//
// The check is a real anchored pattern, deliberately, because the obvious
// shortcut is wrong in a way that hands an attacker your cookies:
//
//   origin.endsWith('.butchercashier.com')   // accepts butchercashier.com.attacker.com
//   origin.includes('butchercashier.com')    // accepts attacker.com/?x=butchercashier.com
//
// Both of those pass for an origin the attacker controls, and with
// `credentials: true` that means the browser hands over the session cookie.

const EXACT_ORIGINS_SEPARATOR = ','
const NO_EXACT_ORIGINS = 0

/** Escapes a literal string for safe interpolation into a RegExp. */
function escapeRegExp(value: string): string {
  // Every metacharacter is individually backslash-escaped rather than written
  // as a bare class. `v` mode reserves `( ) [ ] { } | \` inside a character
  // class, so the conventional `[.*+?^${}()|[\]\\]` is a syntax error under
  // it — and the lint rule requires `v` specifically, not `u`.
  return value.replace(/[.*+?^$\{\}\(\)\|\[\]\\]/gv, '\\$&')
}

/**
 * Builds a matcher for `https://<label>.<domain>`:
 *   - one label only (no dots inside it), so `a.b.evil.com` can't slip past
 *   - anchored at both ends
 *   - https only, plus an optional port for local testing
 */
function wildcardPattern(domain: string): RegExp {
  // The `-` is escaped because `v` mode treats an unescaped one inside a
  // class as a range operator and rejects this outright.
  return new RegExp(`^https://[a-z0-9](?:[a-z0-9\\-]*[a-z0-9])?\\.${escapeRegExp(domain)}(?::\\d+)?$`, 'v')
}

export type OriginChecker = (
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void
) => void

/**
 * `origin` for the `cors` package.
 *
 * Precedence, and why:
 *   1. An exact match in `CORS_ORIGIN` — the escape hatch, and how the current
 *      single-host deployment keeps working unchanged.
 *   2. A subdomain of `CORS_WILDCARD_DOMAIN`, once that's set.
 *   3. Requests with no Origin at all (curl, Postman, server-to-server, and
 *      the health check) are allowed: same-origin and non-browser callers
 *      don't send one, and CORS isn't what protects those anyway — `auth` is.
 *
 * If neither env var is set, everything is reflected. That's the behaviour
 * this app already had, kept so that setting up multi-tenancy can't
 * accidentally lock out a deployment that hasn't been reconfigured yet.
 */
export function buildOriginChecker(): OriginChecker {
  const { env } = process
  const exact = env.CORS_ORIGIN?.split(EXACT_ORIGINS_SEPARATOR).map(o => o.trim()).filter(o => o !== '') ?? []
  const wildcardDomain = env.CORS_WILDCARD_DOMAIN?.trim() ?? ''
  const pattern = wildcardDomain === '' ? null : wildcardPattern(wildcardDomain)

  return (origin, callback) => {
    if (origin === undefined || origin === '') {
      callback(null, true)
      return
    }
    if (exact.length === NO_EXACT_ORIGINS && pattern === null) {
      callback(null, true)
      return
    }
    if (exact.includes(origin)) {
      callback(null, true)
      return
    }
    if (pattern?.test(origin) === true) {
      callback(null, true)
      return
    }
    // `false` rather than an Error: the browser gets a plain missing-CORS-header
    // failure, and the server log doesn't fill with stack traces from scanners.
    callback(null, false)
  }
}
