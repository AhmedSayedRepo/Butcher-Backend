import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../lib/db.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'

const BEARER_PREFIX = 'Bearer '

// Tech debt (ADR-002): the JWT used to live only in an Authorization header,
// with the frontend keeping the raw token in localStorage. Now the cookie is
// the primary transport (httpOnly — inaccessible to frontend JS, mitigates
// XSS token theft) and the Authorization header is kept as a fallback so
// non-browser API clients (e.g. curl, Postman, future mobile clients) still
// work without needing cookie support.
export const AUTH_COOKIE_NAME = 'butcher_token'

export interface AuthRequest extends Request {
  user?: { id: string, email: string, role: string }
}

interface AuthTokenPayload {
  id: string
  email: string
  role: string
}

function isAuthTokenPayload(payload: unknown): payload is AuthTokenPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'id' in payload &&
    'email' in payload &&
    'role' in payload &&
    typeof payload.id === 'string' &&
    typeof payload.email === 'string' &&
    typeof payload.role === 'string'
  )
}

export function requireEnv(name: string): string {
  const { env } = process
  const { [name]: v } = env
  if (v === undefined || v === '') throw new Error(`Missing env var: ${name}`)
  return v
}

// @types/cookie-parser declares `Express.Request.cookies` as `any` (it's
// populated by a runtime middleware, not something the type system can see
// through). Routing it through `unknown` first and narrowing with `in` +
// `typeof` (same style as `isAuthTokenPayload` below) avoids propagating
// `any` into anything @typescript-eslint/no-unsafe-* would flag, without
// relying on a destructuring type annotation to "relabel" an `any` property
// (tsc doesn't actually keep that annotation's optionality — an earlier
// version of this function using `const { cookies }: { cookies?: ... } = req`
// type-checked, but ESLint's type-aware analysis saw straight through it and
// flagged the resulting `?.`/`!== undefined` checks as unreachable).
function extractToken(req: Request): string | null {
  const cookies: unknown = req.cookies
  if (typeof cookies === 'object' && cookies !== null && AUTH_COOKIE_NAME in cookies) {
    const { [AUTH_COOKIE_NAME]: cookieToken } = cookies
    if (typeof cookieToken === 'string' && cookieToken !== '') return cookieToken
  }

  const { headers } = req
  const { authorization } = headers
  const header = authorization ?? ''
  return header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : null
}

// Verify + narrow in one place, returning null for both failure modes. Written
// as a helper rather than inline because a `let` here can't satisfy both
// `init-declarations` (wants an initialiser) and `no-useless-assignment` (says
// that initialiser is never read) at the same time — a function with two
// returns sidesteps the conflict instead of picking which rule to suppress.
function verifyToken(token: string): AuthTokenPayload | null {
  try {
    const decoded: unknown = jwt.verify(token, requireEnv('JWT_SECRET'))
    return isAuthTokenPayload(decoded) ? decoded : null
  } catch {
    return null
  }
}

// v3.1 follow-up 10c: a ban has to take effect NOW, not whenever the banned
// user's 7-day JWT happens to expire — someone being cut off is usually being
// cut off for a reason that won't wait a week. That means one primary-key
// lookup per authenticated request, which is the real cost of this feature and
// is accepted deliberately: it's an indexed single-row read, and nearly every
// route in this app already queries the database anyway.
//
// Checked here rather than in requireRole/requireCap because those only guard
// *some* routes — a banned user would still have been able to read orders,
// inventory and the dashboard, which are behind plain `auth`.
export function auth(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req)
  if (token === null) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }

  const payload = verifyToken(token)
  if (payload === null) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Invalid token' })
    return
  }
  const { id, email, role } = payload

  prisma.user.findUnique({ where: { id }, select: { bannedAt: true } })
    .then((current) => {
      // Deleted account: the token is signed and unexpired but the row is gone.
      if (current === null) {
        res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Invalid token' })
        return
      }
      if (current.bannedAt !== null) {
        res.status(HTTP_STATUS.FORBIDDEN).json({ error: 'This account has been disabled. Contact an administrator.' })
        return
      }
      Object.assign(req, { user: { id, email, role } })
      next()
    })
    .catch(next)
}
