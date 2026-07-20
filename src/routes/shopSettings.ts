import { Router } from 'express'
import { z } from 'zod'
import { OrderStatus, CashTransactionType } from '@prisma/client'
import { prisma } from '../lib/db.js'
import { auth } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import { requireRole, requireCap } from '../middleware/rbac.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'
import { getOrCreateSettings } from '../lib/shopSettings.js'
import { encryptSecret, isEncryptionConfigured } from '../lib/encryption.js'

const router = Router()

// v3 replan (Phase J — pending-order alerting). Single-row config table:
// "how long is too long for a pending order" is shop policy, not a
// per-user preference. GET is open to any authed user (the dashboard's
// polling/alert logic needs to read the threshold regardless of role);
// PATCH is admin-only, same tier as user management — shop-wide policy
// changes, not a day-to-day cashier/manager action.

// v3.1 follow-up 9 (ADR-016): the raw settings row has
// `smtpAppPasswordEncrypted` (AES-256-GCM ciphertext) — this is never sent
// to the client, not even as ciphertext (no reason to hand it out at all).
// `smtpAppPasswordSet` tells the UI whether a password is configured
// (server- or env-var-sourced) without revealing it, same "write-only
// secret field" pattern used by e.g. Stripe/GitHub API-key settings pages.
function toClientSettings<T extends { smtpAppPasswordEncrypted: string | null }>(settings: T): Omit<T, 'smtpAppPasswordEncrypted'> & { smtpAppPasswordSet: boolean } {
  const { smtpAppPasswordEncrypted, ...rest } = settings
  const { env } = process
  const { SMTP_APP_PASSWORD: envPass } = env
  const smtpAppPasswordSet = (smtpAppPasswordEncrypted !== null && smtpAppPasswordEncrypted !== '') || (envPass !== undefined && envPass !== '')
  return { ...rest, smtpAppPasswordSet }
}

router.get('/', auth, asyncHandler(async (_req, res) => {
  const settings = await getOrCreateSettings()
  res.json(toClientSettings(settings))
}))

const MIN_ALERT_MINUTES = 1
const MIN_LOW_STOCK_THRESHOLD_KG = 0
const MIN_MAIL_SENDER_NAME_LENGTH = 1

// v3.1 follow-up 5 (Settings page): defaultLowStockThresholdKg/mailSenderName
// added alongside the existing Phase J fields — same single-row shop-policy
// table, same admin-only PATCH gate.
//
// v3.1 follow-up 9 (ADR-016): smtpUser/smtpAppPassword are both plain
// `z.string()` (not `.min(1)`) so an explicit empty string means "clear
// this field" — distinct from omitting the key entirely, which means
// "leave it as-is". See the PATCH handler below for how that distinction
// is used.
const UpdateShopSettingsSchema = z.object({
  pendingOrderAlertMinutes: z.number().int().min(MIN_ALERT_MINUTES).optional(),
  alertSoundEnabled: z.boolean().optional(),
  defaultLowStockThresholdKg: z.number().gt(MIN_LOW_STOCK_THRESHOLD_KG).optional(),
  mailSenderName: z.string().min(MIN_MAIL_SENDER_NAME_LENGTH).optional(),
  smtpUser: z.string().optional(),
  smtpAppPassword: z.string().optional()
})

router.patch('/', auth, requireRole('admin'), asyncHandler(async (req, res) => {
  const parsed = UpdateShopSettingsSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: parsed.error.flatten() })
    return
  }
  const current = await getOrCreateSettings()
  const { data } = parsed
  const { smtpUser, smtpAppPassword, ...rest } = data

  if (smtpAppPassword !== undefined && smtpAppPassword !== '' && !isEncryptionConfigured()) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: 'SETTINGS_ENCRYPTION_KEY is not configured on the server, so a Gmail app password can\'t be saved here yet. Ask whoever deploys this app to set that env var, or continue using SMTP_APP_PASSWORD as an env var for now.'
    })
    return
  }

  const updated = await prisma.shopSettings.update({
    where: { id: current.id },
    data: {
      ...rest,
      ...(smtpUser === undefined ? {} : { smtpUser: smtpUser === '' ? null : smtpUser }),
      ...(smtpAppPassword === undefined ? {} : { smtpAppPasswordEncrypted: smtpAppPassword === '' ? null : encryptSecret(smtpAppPassword) })
    }
  })
  res.json(toClientSettings(updated))
}))

const ZERO = 0
const EPOCH = new Date(ZERO)

// v3.1 replan (Phase L — closing day, ADR-015). Snapshots everything since
// the last closing (orders since `lastClosedAt`, or the beginning of time
// for the very first closing) into a permanent DailyClosing row, then
// resets `dailyOrderCounter` to 0 so tomorrow's first order is #1 again.
// Gated by `manage_cash` — same tier as every other Cash Management action
// — rather than admin-only, since this is a routine end-of-shift task, not
// a shop-policy change like PATCH / above.
router.post('/close-day', auth, requireCap('manage_cash'), asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }
  const { user } = req
  const settings = await getOrCreateSettings()
  const since = settings.lastClosedAt ?? EPOCH

  const orders = await prisma.order.findMany({
    where: { createdAt: { gte: since }, status: { notIn: [OrderStatus.DRAFT, OrderStatus.CANCELLED] } }
  })
  const totalRevenue = orders.reduce((sum, o) => sum + Number(o.totalAmount), ZERO)

  const cashTx = await prisma.cashTransaction.findMany({ where: { createdAt: { gte: since } } })
  const cashIn = cashTx.filter((t) => t.type === CashTransactionType.IN).reduce((sum, t) => sum + Number(t.amount), ZERO)
  const cashOut = cashTx.filter((t) => t.type === CashTransactionType.OUT).reduce((sum, t) => sum + Number(t.amount), ZERO)

  const closing = await prisma.$transaction(async (tx) => {
    const record = await tx.dailyClosing.create({
      data: {
        closedBy: user.id,
        orderCount: orders.length,
        totalRevenue,
        cashIn,
        cashOut,
        netPosition: cashIn - cashOut
      }
    })
    await tx.shopSettings.update({
      where: { id: settings.id },
      data: { dailyOrderCounter: ZERO, lastClosedAt: record.closedAt }
    })
    return record
  })

  res.status(HTTP_STATUS.CREATED).json(closing)
}))

const RECENT_CLOSINGS_LIMIT = 30

router.get('/closings', auth, requireCap('manage_cash'), asyncHandler(async (_req, res) => {
  const closings = await prisma.dailyClosing.findMany({
    orderBy: { closedAt: 'desc' },
    take: RECENT_CLOSINGS_LIMIT,
    include: { closedByUser: { select: { email: true } } }
  })
  res.json(closings)
}))

export default router
