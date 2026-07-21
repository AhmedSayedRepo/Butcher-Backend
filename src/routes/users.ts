import { Router } from 'express'
import type { Response } from 'express'
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
import { sendInviteEmail, sendPasswordResetEmail } from '../lib/email.js'
import { frontendUrl } from '../lib/frontendUrl.js'

const router = Router()

// One place for the user shape every route returns — `password` and the reset
// tokens are never included.
const USER_FIELDS = {
  id: true, email: true, role: true, caps: true,
  passwordSet: true, bannedAt: true, createdAt: true, updatedAt: true
} as const

// v2 replan, Phase D — admin-only user management, modeled on qa-studio's
// role-plus-capability-toggle admin screen (see ADMIN_USERS_SETUP.md /
// users_screen.py in qa-studio, and ADR-005 in Butcher-Project-Plan-v2.md).
// Every route below is gated by requireRole('admin'), which re-checks the
// DB on each request rather than trusting the JWT's role claim — see the
// comment in middleware/rbac.ts for why that matters specifically here.
router.use(auth, requireRole('admin'))

router.get('/', asyncHandler(async (_req, res) => {
  const users = await prisma.user.findMany({
    select: USER_FIELDS,
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
// the Brevo credentials are configured or if the send fails.
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
        select: USER_FIELDS
      })
    : await prisma.user.update({
        where: { id: existing.id },
        data: { role },
        select: USER_FIELDS
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

// v3.1 follow-up 10c — admin-generated password-reset link.
//
// Why this can safely return the link when POST /auth/forgot-password
// deliberately cannot: that route is PUBLIC and unauthenticated, so returning a
// reset link there would let anybody take over any account by knowing an email
// address. This route sits behind `auth` + `requireRole('admin')` — only an
// already-authenticated admin ever sees the response, which is exactly the same
// reasoning that lets POST /api/users return `setPasswordUrl` for an invite.
//
// Why it exists at all: transactional email is not reliable enough to be the
// only path back into an account. Brevo's free tier shares a sending domain,
// Gmail rate-limits it (421 4.7.28), and a deferred message can sit for hours —
// during which a locked-out cashier has no way in and no admin remedy. This
// gives the admin a link to hand over directly.
//
// It mints a RESET token, not an INVITE one: the difference is the expiry the
// two purposes carry (1 hour vs 7 days) and the email copy. A link an admin
// reads off their screen and passes to someone standing next to them should be
// the short-lived kind.
//
// Every previously-issued token for that user is invalidated first, so an old
// link that leaked cannot still be used once a new one is generated.
router.post('/:id/reset-link', asyncHandler<AuthRequest>(async (req, res) => {
  const { params } = req
  const { id } = params

  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, passwordSet: true }
  })
  if (user === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'User not found' })
    return
  }

  await invalidateOtherTokens(user.id, '')
  const token = await createPasswordResetToken(user.id, PasswordResetTokenPurpose.RESET)
  const resetUrl = `${frontendUrl()}/set-password?token=${token}`

  // Emailed as well as returned. The link on screen is the fallback for when
  // delivery fails; when it works, the user gets it the normal way without the
  // admin having to relay anything.
  const emailSent = await sendPasswordResetEmail(user.email, resetUrl)

  res.json({ resetUrl, emailSent, email: user.email })
}))

// v3.1 follow-up 10c — ban / unban / delete. Admin-only like everything else
// in this router (see the router.use above).
//
// Two guards apply to all three, for the same reason the self-demotion guard
// exists further down: an admin must not be able to lock the shop out of its
// own admin access.
//   1. You cannot ban or delete YOURSELF. There is no legitimate use, and it's
//      the easiest way to strand a single-admin shop with no way back in.
//   2. You cannot ban or delete the LAST remaining active admin, even if it's
//      someone else — otherwise two admins can each remove the other and the
//      shop ends up with none.
const MIN_REMAINING_ADMINS = 1
// Named so the delete guard's "has this user done anything?" check reads as
// intent rather than as a bare comparison against 0.
const NO_ACTIVITY = 0

async function wouldLeaveNoAdmin(targetId: string): Promise<boolean> {
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { role: true } })
  if (target?.role !== 'admin') return false
  const otherActiveAdmins = await prisma.user.count({
    where: { role: 'admin', bannedAt: null, id: { not: targetId } }
  })
  return otherActiveAdmins < MIN_REMAINING_ADMINS
}

function guardTarget(callerId: string, targetId: string, res: Response): boolean {
  if (callerId === targetId) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'You cannot ban or delete your own account.' })
    return false
  }
  return true
}

router.post('/:id/ban', asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }
  const { user: caller, params } = req
  const { id } = params
  if (!guardTarget(caller.id, id, res)) return

  if (await wouldLeaveNoAdmin(id)) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'This is the only active admin — promote someone else first.' })
    return
  }

  const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } })
  if (existing === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'User not found' })
    return
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { bannedAt: new Date() },
    select: USER_FIELDS
  })
  // Any outstanding invite/reset link is killed too: a banned account must not
  // be re-enterable through a link that was mailed out before the ban.
  await invalidateOtherTokens(id, '')
  res.json(updated)
}))

router.post('/:id/unban', asyncHandler<AuthRequest>(async (req, res) => {
  const { params } = req
  const { id } = params
  const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } })
  if (existing === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'User not found' })
    return
  }
  const updated = await prisma.user.update({ where: { id }, data: { bannedAt: null }, select: USER_FIELDS })
  res.json(updated)
}))

// Hard delete, and deliberately REFUSED for any account with history.
//
// Every order, status change, stock adjustment, dismantle event and cash
// transaction carries the `userId` of whoever did it. Deleting a user with any
// of those either fails on the foreign key or, if we cascaded, silently
// destroys the audit trail behind real money and real stock movements — which
// is precisely what ADR-011's append-only rule exists to prevent. So a user who
// has done anything can only be BANNED, and the error says so rather than
// leaving the admin to guess why the button didn't work. Delete stays available
// for the real case it's needed: an invite sent to a mistyped address.
router.delete('/:id', asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }
  const { user: caller, params } = req
  const { id } = params
  if (!guardTarget(caller.id, id, res)) return

  const existing = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      _count: {
        select: {
          orders: true, statusEvents: true, stockAdjustments: true,
          dismantleEvents: true, cashTransactions: true, dailyClosings: true
        }
      }
    }
  })
  if (existing === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'User not found' })
    return
  }
  if (await wouldLeaveNoAdmin(id)) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'This is the only active admin — promote someone else first.' })
    return
  }

  const activity = Object.values(existing._count).reduce((sum, n) => sum + n, NO_ACTIVITY)
  if (activity > NO_ACTIVITY) {
    res.status(HTTP_STATUS.CONFLICT).json({
      error: 'This user has order, stock or cash history, which must stay attributable. Ban the account instead — it blocks sign-in immediately and keeps the audit trail intact.'
    })
    return
  }

  await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.deleteMany({ where: { userId: id } })
    await tx.user.delete({ where: { id } })
  })
  res.status(HTTP_STATUS.NO_CONTENT).send()
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
