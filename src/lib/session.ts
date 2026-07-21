import type { Response } from 'express'
import jwt from 'jsonwebtoken'

// Session lifetime — security audit follow-up, 2026-07-21.
//
// The audit's second finding was that a 7-day JWT with no revocation was the
// weakest remaining link. A ban takes effect immediately (checked on every
// request), but a *stolen cookie* stayed valid for a week — and shop terminals
// are shared, walked away from, and rarely locked.
//
// Two changes, and they work together:
//
//   1. **A much shorter life.** 12 hours by default — about one shift. A cookie
//      lifted from a terminal in the morning is dead by the next day rather
//      than next week.
//
//   2. **Sliding renewal.** A short session that logs out a cashier mid-order
//      is a worse product, and staff work around bad security by writing the
//      password on the till. So the cookie is silently reissued once a session
//      is past halfway, meaning *continuous use never expires* while *idle
//      sessions do*. That's the property actually wanted: "inactive for a
//      while" is the risk, not "signed in for a while".
//
// Deliberately not refresh tokens. Those solve revocation — being able to kill
// a session server-side — which this app already achieves differently: `auth`
// reads the user row on every request, so ban and delete take effect at once.
// A refresh-token table would add a moving part for a problem already solved.

const MILLISECONDS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const MS_PER_HOUR = MILLISECONDS_PER_SECOND * SECONDS_PER_MINUTE * MINUTES_PER_HOUR

const DEFAULT_SESSION_HOURS = 12
const MIN_SESSION_HOURS = 1
const MAX_SESSION_HOURS = 168 // one week — the old behaviour, still reachable
const HALF = 2
// Named so `no-magic-numbers` doesn't flag the two boundary checks below.
const ZERO = 0

/**
 * How long a session lasts, in hours. `SESSION_HOURS` overrides the default,
 * clamped so a typo can't produce a one-second session (locking everyone out)
 * or a one-year one (undoing the point of this file).
 */
export function sessionHours(): number {
  const { env } = process
  const raw = Number(env.SESSION_HOURS ?? '')
  if (!Number.isFinite(raw) || raw <= ZERO) return DEFAULT_SESSION_HOURS
  return Math.min(Math.max(raw, MIN_SESSION_HOURS), MAX_SESSION_HOURS)
}

export function sessionMaxAgeMs(): number {
  return sessionHours() * MS_PER_HOUR
}

/**
 * The `expiresIn` value jsonwebtoken expects.
 *
 * Typed as the template literal `` `${number}h` `` rather than `string`:
 * jsonwebtoken narrows this option to the `ms` package's `StringValue` union,
 * and a plain `string` isn't assignable to it. Keeping the precise type means
 * the compiler checks the format instead of a cast silencing it.
 */
export function sessionExpiresIn(): `${number}h` {
  return `${sessionHours()}h`
}

/**
 * True once a token is past the halfway point of its life, which is when the
 * cookie is worth reissuing.
 *
 * Halfway rather than "every request": reissuing on every request means a
 * `Set-Cookie` header on every response, which is wasted bytes on a polling
 * dashboard. Halfway guarantees an actively-used session is always renewed
 * with at least half its lifetime left — so it can never expire mid-use.
 *
 * `iat`/`exp` are seconds since epoch, per the JWT spec.
 */
export function shouldRenew(issuedAtSeconds: number | undefined, expiresAtSeconds: number | undefined): boolean {
  if (issuedAtSeconds === undefined || expiresAtSeconds === undefined) return false
  const lifetime = expiresAtSeconds - issuedAtSeconds
  if (lifetime <= ZERO) return false
  const elapsed = Date.now() / MILLISECONDS_PER_SECOND - issuedAtSeconds
  return elapsed > lifetime / HALF
}

// ── Cookie ──────────────────────────────────────────────────────────────────
// These options live here rather than in routes/auth.ts because three places
// now need them identically: login (set), logout (clear) and the sliding
// renewal in middleware/auth.ts (re-set). Two copies of a cookie's flags is
// precisely how the logout bug happened once already — `clearCookie` silently
// does nothing unless every option matches the original `res.cookie` call.

export interface SessionCookieOptions {
  httpOnly: true
  secure: boolean
  sameSite: 'none' | 'lax'
  maxAge: number
  path: string
}

export function cookieOptions(): SessionCookieOptions {
  // Cross-site in production (frontend on Vercel, API on Render), so
  // SameSite=None + Secure is required; local dev is same-site, where Lax
  // works and Secure would break plain-HTTP localhost.
  const isProd = process.env.NODE_ENV === 'production'
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: sessionMaxAgeMs(),
    path: '/'
  }
}

/** The cookie name. Kept here so it can't drift from the options above. */
export const AUTH_COOKIE_NAME = 'butcher_token'

/**
 * Issues a fresh cookie for an already-authenticated user — the sliding
 * renewal. Deliberately mints a NEW token rather than extending the old one's
 * cookie: a JWT's `exp` is signed, so a longer `maxAge` on the same token
 * would just leave the browser holding something the server rejects.
 */
export function renewSessionCookie(
  res: Response,
  user: { id: string, email: string, role: string }
): void {
  // Two steps, and not by choice: `prefer-destructuring` is configured with
  // `enforceForRenamedProperties: true`, and the base rule reports *any*
  // declarator whose initializer is a member expression — including one that
  // already destructures. `const { JWT_SECRET } = process.env` is flagged just
  // the same. Binding `process.env` to a plain identifier first gives the
  // second declarator a non-member initializer, which is the shape the rule
  // accepts. `lib/tenant.ts` reaches for the same `const { env } = process`
  // for the same reason.
  const { env } = process
  const { JWT_SECRET: secret } = env
  // Renewal is a nicety, not a correctness requirement: if the secret were
  // missing, `auth` could not have verified the token that got us here. This
  // guard exists only so a misconfiguration degrades to "no renewal" rather
  // than throwing inside a request that has otherwise succeeded.
  if (secret === undefined || secret === '') return
  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    secret,
    { expiresIn: sessionExpiresIn() }
  )
  res.cookie(AUTH_COOKIE_NAME, token, cookieOptions())
}
