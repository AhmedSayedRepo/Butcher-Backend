// Multi-tenancy phase 3 (Butcher-Multi-Tenancy-Plan.md §3) — slug rules and
// the two per-request tenant checks.
//
// These are pure helpers rather than Express middlewares, and `auth` calls
// them. That's deliberate: as middlewares they'd have to be mounted after
// `auth` on all fifteen routers (they need `req.user`), each doing its own
// database lookup — three queries per request, and a new router added later
// would silently miss them. Folded into `auth`, the organization comes back on
// the same single row lookup `auth` already does for the ban check, and no
// route can opt out by forgetting.
//
// The division of responsibility is the security-critical part of the design,
// so plainly: **the session decides which data you get; the subdomain only
// decides which login page you saw.** `auth` reads `organizationId` off the
// user's row and opens the tenant context from it. Nothing here widens that.
// `subdomainMismatch` only ever *narrows* — it can refuse a request, never
// grant one.

/** Where the frontend puts the subdomain it was loaded from. */
export const ORG_SLUG_HEADER = 'x-organization-slug'

// A single DNS label. Anything else is a client bug or a probe.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?$/v
const MIN_SLUG_LENGTH = 3
const MAX_SLUG_LENGTH = 40

// Subdomains that can never be a shop: infrastructure, or the bare apex.
// Enforced at read time as well as at creation, because a slug that arrived
// some other way — a hand-written insert, a restored backup — must not become
// routable just because it exists.
const RESERVED_SLUGS = new Set([
  'www', 'api', 'app', 'admin', 'mail', 'smtp', 'static', 'assets', 'cdn',
  'status', 'help', 'support', 'docs', 'blog', 'dev', 'staging', 'test'
])

export function isValidSlug(slug: string): boolean {
  return (
    slug.length >= MIN_SLUG_LENGTH &&
    slug.length <= MAX_SLUG_LENGTH &&
    SLUG_PATTERN.test(slug) &&
    !RESERVED_SLUGS.has(slug)
  )
}

/** The subdomain the browser claims to be on, or null if it didn't say. */
export function requestedSlug(headerValue: string | string[] | undefined): string | null {
  const value = typeof headerValue === 'string' ? headerValue.trim().toLowerCase() : ''
  return value === '' ? null : value
}

/**
 * True when the caller is signed into a different organization than the
 * subdomain names.
 *
 * A missing header means "no opinion" and passes. That isn't a hole — it's
 * what keeps the current single-host deployment
 * (`butcher-frontend-eight.vercel.app`, no subdomain) working unchanged, and
 * the session still decides the data either way.
 */
export function subdomainMismatch(requested: string | null, actualSlug: string | null): boolean {
  return requested !== null && actualSlug !== null && requested !== actualSlug
}

// Writes are refused for a suspended organization; reads are not.
//
// Your call, and the right one: a shop behind on payment still has a legal
// need to read its own cash ledger and order history, and locking them out of
// records they're required to keep turns a billing dispute into a much worse
// one. Blocking writes applies the pressure without that problem.
//
// Keyed off the HTTP method rather than a list of routes, so a route added
// later is covered without anyone remembering to cover it.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
export const SUSPENDED_STATUS = 'suspended'

export function isBlockedByBilling(method: string, billingStatus: string | null): boolean {
  return !SAFE_METHODS.has(method) && billingStatus === SUSPENDED_STATUS
}
