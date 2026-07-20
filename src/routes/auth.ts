import { Router } from 'express'
import { z } from 'zod'
import rateLimit from 'express-rate-limit'
import { prisma } from '../lib/db.js'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { PasswordResetTokenPurpose } from '@prisma/client'
import { AUTH_COOKIE_NAME, auth, requireEnv } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'
import { effectiveCaps } from '../lib/caps.js'
import { createPasswordResetToken, findValidToken, invalidateOtherTokens } from '../lib/passwordResetToken.js'
import { sendPasswordResetEmail } from '../lib/email.js'
import { frontendUrl } from '../lib/frontendUrl.js'

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
  // Bug fix: clearCookie's options must match the ones used in the original
  // res.cookie() call (minus maxAge) or the browser won't recognize it as
  // the same cookie and silently keeps the old one — this is documented
  // Express behavior, not a caching/deploy issue. Was previously just
  // `{ path: '/' }`, which omitted `secure`/`sameSite`; in production the
  // login cookie is set with `sameSite: 'none', secure: true`, so the
  // mismatched clear request was ignored by the browser and the auth cookie
  // never actually got deleted on logout — the user stayed logged in.
  const { httpOnly, secure, sameSite, path } = cookieOptions()
  res.clearCookie(AUTH_COOKIE_NAME, { httpOnly, secure, sameSite, path })
  res.status(HTTP_STATUS.OK).json({ ok: true })
})

// v2 replan (Phase D): now also returns effective caps, computed fresh from
// the DB rather than the JWT — the JWT only ever carried id/email/role (see
// middleware/auth.ts), and caps didn't exist yet when that shape was fixed.
// This is the one place a plain (not requireRole/requireCap-gated) endpoint
// does a DB round-trip for role/caps freshness: it's called once per page
// load via the frontend's useAuth() hook, not per-request like a route
// guard, so the extra query here is cheap and keeps the UI's "what can I
// see" decision in sync with the latest admin change without waiting for
// the cookie to be reissued.
router.get('/me', auth, asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }
  const current = await prisma.user.findUnique({ where: { id: req.user.id }, select: { role: true, caps: true } })
  if (current === null) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }
  res.json({ ...req.user, role: current.role, caps: effectiveCaps(current.role, current.caps) })
}))

// v3 follow-up: self-service password reset. Same rate-limiting reasoning
// as loginLimiter above — this endpoint accepts arbitrary emails from
// anyone, so it needs its own throttle independent of the login one.
const FORGOT_PASSWORD_WINDOW_MINUTES = 15
const FORGOT_PASSWORD_MAX_ATTEMPTS_PER_WINDOW = 5
const forgotPasswordLimiter = rateLimit({
  windowMs: FORGOT_PASSWORD_WINDOW_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND,
  limit: FORGOT_PASSWORD_MAX_ATTEMPTS_PER_WINDOW,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' }
})

const ForgotPasswordSchema = z.object({ email: z.string().email() })

// Deliberately always responds 200 with the same body whether or not the
// email matches a real account — a different response (404 vs 200) would
// let anyone enumerate which emails have accounts, just by trying
// "forgot password" against a list of guesses.
router.post('/forgot-password', forgotPasswordLimiter, asyncHandler(async (req, res) => {
  const parsed = ForgotPasswordSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: parsed.error.flatten() })
    return
  }
  const { data } = parsed
  const { email } = data

  const user = await prisma.user.findUnique({ where: { email } })
  if (user !== null) {
    const token = await createPasswordResetToken(user.id, PasswordResetTokenPurpose.RESET)
    const resetUrl = `${frontendUrl()}/set-password?token=${token}`
    void sendPasswordResetEmail(email, resetUrl)
  }

  res.status(HTTP_STATUS.OK).json({ ok: true })
}))

// Lets the frontend show "this link is invalid/expired" before the user
// even types a new password, rather than only finding out on submit.
router.get('/reset-token/:token', asyncHandler(async (req, res) => {
  const { params } = req
  const { token } = params
  const record = await findValidToken(token)
  res.json({ valid: record !== null, email: record?.user.email ?? null })
}))

const MIN_PASSWORD_LENGTH = 8

const ResetPasswordSchema = z.object({
  token: z.string().min(MIN_FIELD_LENGTH),
  password: z.string().min(MIN_PASSWORD_LENGTH)
})

// Handles both the admin-invite "set your password" flow and self-service
// "forgot password" — identical validation either way (see
// lib/passwordResetToken.ts), only the emailed copy differs.
router.post('/reset-password', asyncHandler(async (req, res) => {
  const parsed = ResetPasswordSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: parsed.error.flatten() })
    return
  }
  const { data } = parsed
  const { token, password } = data

  const record = await findValidToken(token)
  if (record === null) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'This link is invalid or has expired. Request a new one.' })
    return
  }

  const hash = await bcrypt.hash(password, 10)
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: record.userId }, data: { password: hash, passwordSet: true } })
    await tx.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } })
  })
  await invalidateOtherTokens(record.userId, record.id)

  res.status(HTTP_STATUS.OK).json({ ok: true })
}))

export default router
