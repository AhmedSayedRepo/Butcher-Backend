import { Router } from 'express'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { prismaUnscoped } from '../lib/db.js'
import { auth } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import { requireSuperAdmin } from '../middleware/rbac.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'
import { apiError, ERROR_CODES } from '../lib/errorCodes.js'
import { isValidSlug } from '../middleware/tenant.js'
import { createPasswordResetToken } from '../lib/passwordResetToken.js'
import { PasswordResetTokenPurpose } from '@prisma/client'
import { sendInviteEmail } from '../lib/email.js'

// Multi-tenancy phase 5 — organization management
// (Butcher-Multi-Tenancy-Plan.md §6). Super admin only, every route.
//
// EVERY query here uses `prismaUnscoped`, and that is the point of this file:
// managing organizations means reading across all of them, which is precisely
// what the tenant extension exists to prevent. This is the one module where
// that filter is deliberately off, which is why it's a separate file behind
// its own gate rather than a few endpoints tucked into users.ts.
const router = Router()

router.use(auth, requireSuperAdmin)

const BCRYPT_SALT_ROUNDS = 10
const MIN_NAME_LENGTH = 1
const MAX_TEXT_LENGTH = 200

// `plan` and `billingStatus` are validated against a list but stored as text
// (see the schema): the list is the current product, the column is the
// long-lived thing. Adding a plan should be a deploy, not a migration.
const PLANS = ['trial', 'basic', 'pro'] as const
const BILLING_STATUSES = ['active', 'past_due', 'suspended', 'cancelled'] as const

const CreateOrganizationSchema = z.object({
  slug: z.string(),
  name: z.string().min(MIN_NAME_LENGTH).max(MAX_TEXT_LENGTH),
  email: z.string().email().max(MAX_TEXT_LENGTH),
  phone: z.string().max(MAX_TEXT_LENGTH).nullable().optional(),
  address: z.string().max(MAX_TEXT_LENGTH).nullable().optional(),
  plan: z.enum(PLANS).optional(),
  billingStatus: z.enum(BILLING_STATUSES).optional(),
  billingEmail: z.string().email().max(MAX_TEXT_LENGTH).nullable().optional(),
  // The first admin. Optional, but omitting it produces a shop nobody can sign
  // into — a support ticket on day one — so the UI always sends it.
  adminEmail: z.string().email().max(MAX_TEXT_LENGTH).optional()
})

// `slug` is absent on purpose: it's the routing key, and changing it breaks
// every bookmark staff have and every invite link already sent. Forbidden
// after creation. If a customer genuinely rebrands, that wants a redirect
// table, not a silent rename — see plan §6.
const UpdateOrganizationSchema = z.object({
  name: z.string().min(MIN_NAME_LENGTH).max(MAX_TEXT_LENGTH).optional(),
  email: z.string().email().max(MAX_TEXT_LENGTH).optional(),
  phone: z.string().max(MAX_TEXT_LENGTH).nullable().optional(),
  address: z.string().max(MAX_TEXT_LENGTH).nullable().optional(),
  plan: z.enum(PLANS).optional(),
  billingStatus: z.enum(BILLING_STATUSES).optional(),
  trialEndsAt: z.string().datetime().nullable().optional(),
  billingEmail: z.string().email().max(MAX_TEXT_LENGTH).nullable().optional(),
  externalCustomerId: z.string().max(MAX_TEXT_LENGTH).nullable().optional(),
  slug: z.string().optional()
})

const ORGANIZATION_FIELDS = {
  id: true,
  slug: true,
  name: true,
  email: true,
  phone: true,
  address: true,
  plan: true,
  billingStatus: true,
  trialEndsAt: true,
  billingEmail: true,
  externalCustomerId: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true
} as const

// GET /api/organizations
router.get('/', asyncHandler(async (_req, res) => {
  const organizations = await prismaUnscoped.organization.findMany({
    select: {
      ...ORGANIZATION_FIELDS,
      // Enough to answer "is this one actually being used?" without opening
      // any of the shop's real data. Counts are not customer records.
      _count: { select: { users: true, orders: true, products: true } }
    },
    orderBy: [{ archivedAt: 'asc' }, { createdAt: 'desc' }]
  })
  res.json(organizations)
}))

// POST /api/organizations
router.post('/', asyncHandler<AuthRequest>(async (req, res) => {
  const parsed = CreateOrganizationSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json(apiError(ERROR_CODES.VALIDATION_FAILED, 'Validation failed', undefined, parsed.error.flatten()))
    return
  }
  const { data } = parsed
  const slug = data.slug.trim().toLowerCase()

  if (!isValidSlug(slug)) {
    res.status(HTTP_STATUS.BAD_REQUEST).json(apiError(
      ERROR_CODES.SLUG_INVALID,
      'Slug must be 3-40 characters of lowercase letters, digits or hyphens, and not a reserved name'
    ))
    return
  }

  const clash = await prismaUnscoped.organization.findUnique({ where: { slug }, select: { id: true } })
  if (clash !== null) {
    res.status(HTTP_STATUS.CONFLICT).json(apiError(ERROR_CODES.SLUG_TAKEN, 'That subdomain is already taken', { slug }))
    return
  }

  // Checked BEFORE anything is written, because `User.email` is globally
  // unique across the whole platform (see the schema comment on that field —
  // it stays global until subdomains make login unambiguous). Without this
  // check the create below throws a unique-constraint error, which surfaces as
  // an unexplained 500.
  //
  // This is not hypothetical: it happened on the very first real use of this
  // endpoint. The address given as the new shop's admin already existed as a
  // cashier in the default organization.
  if (data.adminEmail !== undefined) {
    const emailTaken = await prismaUnscoped.user.findUnique({
      where: { email: data.adminEmail },
      select: { id: true }
    })
    if (emailTaken !== null) {
      res.status(HTTP_STATUS.CONFLICT).json(apiError(
        ERROR_CODES.EMAIL_ALREADY_EXISTS,
        'That email already has an account. Email addresses are unique across every shop, so use a different one for this shop\'s admin.'
      ))
      return
    }
  }

  // ONE transaction for the organization, its settings AND its first admin.
  //
  // The admin used to be created after the transaction committed, to avoid
  // holding it open across the invite email. That was wrong, and the first
  // real use proved it: the admin's email collided, the create threw, and the
  // organization was already committed — leaving a shop with no way in and a
  // slug that then blocked the retry with "already taken".
  //
  // The email is the slow part, not the user row, so only the email moved out.
  const { organization, adminId } = await prismaUnscoped.$transaction(async (tx) => {
    const created = await tx.organization.create({
      data: {
        slug,
        name: data.name,
        email: data.email,
        phone: data.phone ?? null,
        address: data.address ?? null,
        plan: data.plan ?? 'trial',
        billingStatus: data.billingStatus ?? 'active',
        billingEmail: data.billingEmail ?? null
      },
      select: ORGANIZATION_FIELDS
    })

    // The settings row is created eagerly rather than lazily on first read,
    // because `shopName` should say the shop's name from the first login
    // rather than the product's.
    await tx.shopSettings.create({
      data: { organizationId: created.id, shopName: data.name, shopPhone: data.phone ?? null, shopAddress: data.address ?? null }
    })

    if (data.adminEmail === undefined) return { organization: created, adminId: null }

    const admin = await tx.user.create({
      data: {
        email: data.adminEmail,
        password: await bcrypt.hash(crypto.randomUUID(), BCRYPT_SALT_ROUNDS),
        role: 'admin',
        passwordSet: false,
        organizationId: created.id
      },
      select: { id: true }
    })
    return { organization: created, adminId: admin.id }
  })

  // Token and email outside the transaction: sending mail inside one holds a
  // database transaction open for the length of an HTTP call to Brevo.
  //
  // If the email fails the organization still exists and is usable — the link
  // comes back in the response for exactly that case.
  let inviteUrl: string | null = null
  let inviteEmailSent = false
  if (adminId !== null && data.adminEmail !== undefined) {
    const token = await createPasswordResetToken(adminId, PasswordResetTokenPurpose.INVITE)
    const { env } = process
    inviteUrl = `${env.FRONTEND_URL ?? ''}/set-password?token=${token}`
    inviteEmailSent = await sendInviteEmail(data.adminEmail, inviteUrl, 'admin')
  }

  // The link is returned as well as emailed, same as the existing invite flow:
  // only an authenticated super admin sees this response, and email is not
  // reliable enough to be the only way in.
  res.status(HTTP_STATUS.CREATED).json({ ...organization, inviteUrl, inviteEmailSent })
}))

// PATCH /api/organizations/:id
router.patch('/:id', asyncHandler(async (req, res) => {
  const parsed = UpdateOrganizationSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json(apiError(ERROR_CODES.VALIDATION_FAILED, 'Validation failed', undefined, parsed.error.flatten()))
    return
  }
  const { data } = parsed
  const { params } = req
  const { id } = params

  if (data.slug !== undefined) {
    res.status(HTTP_STATUS.BAD_REQUEST).json(apiError(
      ERROR_CODES.SLUG_IMMUTABLE,
      "An organization's subdomain can't be changed — it's in every bookmark and every invite link already sent."
    ))
    return
  }

  const existing = await prismaUnscoped.organization.findUnique({ where: { id }, select: { id: true } })
  if (existing === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json(apiError(ERROR_CODES.ORGANIZATION_NOT_FOUND, 'Organization not found'))
    return
  }

  const { slug: _ignored, trialEndsAt, ...rest } = data
  const updated = await prismaUnscoped.organization.update({
    where: { id },
    data: {
      ...rest,
      ...(trialEndsAt === undefined ? {} : { trialEndsAt: trialEndsAt === null ? null : new Date(trialEndsAt) })
    },
    select: ORGANIZATION_FIELDS
  })
  res.json(updated)
}))

// POST /api/organizations/:id/archive  — and /unarchive
//
// Archive, not delete. An organization's rows are its orders, its cash ledger
// and its stock history — the records it may legally need to keep, and the
// ones you'd want if the closure turns out to be a mistake or a dispute. The
// same reasoning that made user deletion return 409, with more at stake.
router.post('/:id/archive', asyncHandler<AuthRequest>(async (req, res) => {
  const { params } = req
  const { id } = params
  const { user } = req

  // A super admin belongs to no organization, so this can't lock *them* out —
  // but it's still worth refusing to archive your own, in case the flag is
  // ever granted to a shop account.
  if (user?.organizationId === id) {
    res.status(HTTP_STATUS.BAD_REQUEST).json(apiError(ERROR_CODES.CANNOT_TARGET_SELF, 'You cannot archive your own organization.'))
    return
  }

  const existing = await prismaUnscoped.organization.findUnique({ where: { id }, select: { id: true } })
  if (existing === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json(apiError(ERROR_CODES.ORGANIZATION_NOT_FOUND, 'Organization not found'))
    return
  }

  const updated = await prismaUnscoped.organization.update({
    where: { id },
    data: { archivedAt: new Date() },
    select: ORGANIZATION_FIELDS
  })
  res.json(updated)
}))

router.post('/:id/unarchive', asyncHandler(async (req, res) => {
  const { params } = req
  const { id } = params
  const existing = await prismaUnscoped.organization.findUnique({ where: { id }, select: { id: true } })
  if (existing === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json(apiError(ERROR_CODES.ORGANIZATION_NOT_FOUND, 'Organization not found'))
    return
  }
  const updated = await prismaUnscoped.organization.update({
    where: { id },
    data: { archivedAt: null },
    select: ORGANIZATION_FIELDS
  })
  res.json(updated)
}))

// DELETE /api/organizations/:id
//
// Only ever succeeds for an organization that has nothing in it — a mistyped
// slug created a minute ago. Anything with history returns 409 and points at
// archive instead. The foreign keys are ON DELETE RESTRICT, so the database
// would refuse anyway; this exists to fail with an explanation rather than a
// constraint violation.
router.delete('/:id', asyncHandler(async (req, res) => {
  const { params } = req
  const { id } = params

  const existing = await prismaUnscoped.organization.findUnique({
    where: { id },
    select: {
      id: true,
      _count: {
        select: {
          users: true, orders: true, products: true, customers: true,
          cashTransactions: true, dismantleEvents: true, dailyClosings: true,
          stockAdjustments: true
        }
      }
    }
  })
  if (existing === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json(apiError(ERROR_CODES.ORGANIZATION_NOT_FOUND, 'Organization not found'))
    return
  }

  const NO_ACTIVITY = 0
  const activity = Object.values(existing._count).reduce((sum, n) => sum + n, NO_ACTIVITY)
  if (activity > NO_ACTIVITY) {
    res.status(HTTP_STATUS.CONFLICT).json(apiError(
      ERROR_CODES.ORGANIZATION_HAS_DATA,
      'This organization has users or trading history, which must stay intact. Archive it instead — that blocks sign-in immediately and keeps the records.'
    ))
    return
  }

  // Settings is the one row created eagerly at organization creation, so an
  // otherwise-empty organization still has it.
  await prismaUnscoped.$transaction(async (tx) => {
    await tx.shopSettings.deleteMany({ where: { organizationId: id } })
    await tx.organization.delete({ where: { id } })
  })
  res.status(HTTP_STATUS.NO_CONTENT).send()
}))

export default router
