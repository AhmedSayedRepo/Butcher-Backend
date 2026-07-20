import { Router } from 'express'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { PasswordResetTokenPurpose } from '@prisma/client'
import { prisma } from '../lib/db.js'
import { auth } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import { requireRole } from '../middleware/rbac.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'
import { ROLES, CAPS } from '../lib/caps.js'
import type { Role } from '../lib/caps.js'
import { createPasswordResetToken, invalidateOtherTokens } from '../lib/passwordResetToken.js'
import { sendInviteEmail } from '../lib/email.js'
import { frontendUrl } from '../lib/frontendUrl.js'

const router = Router()

// v2 replan, Phase D — admin-only user management, modeled on qa-studio's
// role-plus-capability-toggle admin screen (see ADMIN_USERS_SETUP.md /
// users_screen.py in qa-studio, and ADR-005 in Butcher-Project-Plan-v2.md).
// Every route below is gated by requireRole('admin'), which re-checks the
// DB on each request rather than trusting the JWT's role claim — see the
// comment in middleware/rbac.ts for why that matters specifically here.
router.use(auth, requireRole('admin'))

router.get('/', asyncHandler(async (_req, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, role: true, caps: true, passwordSet: true, createdAt: true, updatedAt: true },
    orderBy: { createdAt: 'asc' }
  })
  res.json(users)
}))

const InviteUserSchema = z.object({
  email: z.string().email(),
  role: z.enum(ROLES).default('cashier')
})

const BCRYPT_SALT_ROUNDS = 10

// v3 follow-up: the only way to create a new user account, per the
// "admin invites, user sets password" decision — there is no public
// self-signup route anywhere in this app. Creates the row with an
// unusable random password hash (same pattern as the WhatsApp system user
// in prisma/seed.ts) and `passwordSet: false`, generates a single-use
// invite token, and emails a "set your password" link. Also returns the
// link directly in the response — unlike the self-service forgot-password
// flow (which must never do this, or anyone could hijack any account by
// email address alone), this is safe here because only an already-
// authenticated admin ever sees this response, and it doubles as a manual
// fallback for sharing the link (WhatsApp, in person, etc.) before
// RESEND_API_KEY is configured or if the send fails.
router.post('/', asyncHandler<AuthRequest>(async (req, res) => {
  const parsed = InviteUserSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: parsed.error.flatten() })
    return
  }
  const { data } = parsed
  const { email, role } = data

  const existing = await prisma.user.findUnique({ where: { email } })

  // v3.1 bug fix: an account that already completed signup (a real,
  // active user) is a genuine conflict — block it as before. But an
  // account that's still `passwordSet: false` (invited, never activated)
  // previously hit this exact same 409 on any retry, which is a dead end:
  // the common reason an admin retries is that the *first* invite's email
  // failed to send (e.g. Resend's sandbox `onboarding@resend.dev` address
  // can only deliver to the Resend account's own email, not an arbitrary
  // invitee — see backend/.env.example) and they never got a working link.
  // Treat this case as "resend the invite" instead: issue a fresh token
  // (invalidating any old ones), let the role be updated too since the
  // account was never actually activated, and try sending again.
  if (existing?.passwordSet === true) {
    res.status(HTTP_STATUS.CONFLICT).json({ error: 'A user with that email already exists' })
    return
  }

  const user = existing === null
    ? await prisma.user.create({
        data: { email, password: await bcrypt.hash(crypto.randomUUID(), BCRYPT_SALT_ROUNDS), role, passwordSet: false },
        select: { id: true, email: true, role: true, caps: true, passwordSet: true, createdAt: true, updatedAt: true }
      })
    : await prisma.user.update({
        where: { id: existing.id },
        data: { role },
        select: { id: true, email: true, role: true, caps: true, passwordSet: true, createdAt: true, updatedAt: true }
      })

  if (existing !== null) {
    // Kill every still-outstanding token from the earlier attempt(s) first
    // — an empty exceptTokenId matches no real row, so this invalidates
    // all of them, not "all but one" — before minting the fresh one below,
    // so only the newest link is ever valid.
    await invalidateOtherTokens(user.id, '')
  }
  const token = await createPasswordResetToken(user.id, PasswordResetTokenPurpose.INVITE)
  const setPasswordUrl = `${frontendUrl()}/set-password?token=${token}`
  const emailSent = await sendInviteEmail(email, setPasswordUrl, role)

  res.status(existing === null ? HTTP_STATUS.CREATED : HTTP_STATUS.OK).json({ user, setPasswordUrl, emailSent })
}))

const UpdateUserSchema = z.object({
  role: z.enum(ROLES).optional(),
  caps: z.array(z.enum(CAPS)).optional(),
  // Required to actually go through when an admin demotes THEIR OWN account
  // away from admin — see the self-demotion guard below. Omitted/false on
  // the first attempt returns a `confirmation_required` response instead of
  // applying the change, so the frontend can show a confirm dialog before
  // resubmitting with this set to true.
  confirm: z.boolean().optional()
})

// Pulled out of the route handler so the multi-condition boolean expression
// (and the branching it implies) doesn't count against the handler's own
// cyclomatic complexity — see the self-demotion guard comment above.
function isSelfDemotion(callerId: string, target: { id: string, role: string }, nextRole: Role | undefined): boolean {
  const isSelf = callerId === target.id
  const isDemotingFromAdmin = target.role === 'admin' && nextRole !== undefined && nextRole !== 'admin'
  return isSelf && isDemotingFromAdmin
}

router.patch('/:id', asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }
  // Already object destructuring in all three cases below; see the comment
  // in middleware/rbac.ts for why @typescript-eslint/prefer-destructuring
  // still flags these (confirmed false positive across repeated real lint
  // runs, not a config guess).
  // eslint-disable-next-line @typescript-eslint/prefer-destructuring -- already destructured; documented false-positive on narrowed optional Express Request properties
  const { id: callerId } = req.user

  // eslint-disable-next-line @typescript-eslint/prefer-destructuring -- already destructured; documented false-positive on narrowed optional Express Request properties
  const { id } = req.params
  const parsed = UpdateUserSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: parsed.error.flatten() })
    return
  }
  // eslint-disable-next-line @typescript-eslint/prefer-destructuring -- already destructured; documented false-positive on narrowed optional Express Request properties
  const { role, caps, confirm } = parsed.data

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } })
  if (target === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'User not found' })
    return
  }

  if (isSelfDemotion(callerId, target, role) && confirm !== true) {
    res.status(HTTP_STATUS.CONFLICT).json({
      error: 'confirmation_required',
      message: 'This removes your own admin access. Resubmit with confirm: true to proceed.'
    })
    return
  }

  const updated = await prisma.user.update({
    where: { id },
    data: {
      ...(role === undefined ? {} : { role }),
      ...(caps === undefined ? {} : { caps })
    },
    select: { id: true, email: true, role: true, caps: true, passwordSet: true, createdAt: true, updatedAt: true }
  })
  res.json(updated)
}))

export default router
