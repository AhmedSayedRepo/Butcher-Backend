import { Router } from 'express'
import { z } from 'zod'
import rateLimit from 'express-rate-limit'
import { prisma } from '../lib/db'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { AUTH_COOKIE_NAME, auth, requireEnv } from '../middleware/auth'
import type { AuthRequest } from '../middleware/auth'
import { asyncHandler } from '../lib/asyncHandler'
import { HTTP_STATUS } from '../lib/httpStatus'

const router = Router()

const MIN_FIELD_LENGTH = 1

// Named-once constants. Unlike lib/httpStatus.ts (numeric *values inside an
// object literal*, which no-magic-numbers does flag), plain top-level
// `const NAME = <number>` declarations like these are already exempt under
// eslint-config-love's config — confirmed by a real lint run flagging the
// eslint-disable pair that used to wrap this block as unused.
const MILLISECONDS_PER_SECOND = 1000
const SECONDS_PER_DAY = 86400
const COOKIE_MAX_AGE_DAYS = 7
const SECONDS_PER_MINUTE = 60
const LOGIN_WINDOW_MINUTES = 15
const LOGIN_MAX_ATTEMPTS_PER_WINDOW = 10
const COOKIE_MAX_AGE_MS = COOKIE_MAX_AGE_DAYS * SECONDS_PER_DAY * MILLISECONDS_PER_SECOND

// Phase 5 hardening: /auth/login had no protection against credential
// stuffing / brute force — anyone could hammer it as fast as the network
// allowed. Keyed on IP by default (express-rate-limit's standard behavior);
// good enough for a single-instance deployment. A distributed rate limiter
// (Redis-backed store) would be the next step if this ever runs multi-instance.
const loginLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND,
  limit: LOGIN_MAX_ATTEMPTS_PER_WINDOW,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' }
})

// Tech debt (ADR-002), now resolved: the token is set as an httpOnly cookie
// instead of being handed to the frontend as JSON to store in localStorage.
// Cross-site cookies (frontend and backend on different domains in
// production, e.g. Vercel + Railway) require SameSite=None + Secure; same-site
// local dev (both on localhost, different ports) works fine with Lax.
function cookieOptions(): {
  httpOnly: true
  secure: boolean
  sameSite: 'none' | 'lax'
  maxAge: number
  path: string
} {
  const isProd = process.env.NODE_ENV === 'production'
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/'
  }
}

const LoginSchema = z.object({
  email: z.string().min(MIN_FIELD_LENGTH),
  password: z.string().min(MIN_FIELD_LENGTH)
})

router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'email and password required' })
    return
  }
  const { data } = parsed
  const { email, password } = data

  const user = await prisma.user.findUnique({ where: { email } })
  if (user === null) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Invalid credentials' })
    return
  }

  const ok = await bcrypt.compare(password, user.password)
  if (!ok) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Invalid credentials' })
    return
  }

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, requireEnv('JWT_SECRET'), { expiresIn: '7d' })
  res.cookie(AUTH_COOKIE_NAME, token, cookieOptions())
  res.json({ user: { id: user.id, email: user.email, role: user.role } })
}))

router.post('/logout', (_req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, { path: '/' })
  res.status(HTTP_STATUS.OK).json({ ok: true })
})

// No `asyncHandler` needed here — nothing async happens once `auth` has
// already verified the token; wrapping a handler with no `await` in an
// `async` function trips @typescript-eslint/require-await for no reason.
router.get('/me', auth, (req: AuthRequest, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }
  res.json(req.user)
})

export default router
