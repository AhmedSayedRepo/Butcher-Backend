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

const router = Router()

// v3 replan (Phase J — pending-order alerting). Single-row config table:
// "how long is too long for a pending order" is shop policy, not a
// per-user preference. GET is open to any authed user (the dashboard's
// polling/alert logic needs to read the threshold regardless of role);
// PATCH is admin-only, same tier as user management — shop-wide policy
// changes, not a day-to-day cashier/manager action.

router.get('/', auth, asyncHandler(async (_req, res) => {
  const settings = await getOrCreateSettings()
  res.json(settings)
}))

const MIN_ALERT_MINUTES = 1

const UpdateShopSettingsSchema = z.object({
  pendingOrderAlertMinutes: z.number().int().min(MIN_ALERT_MINUTES).optional(),
  alertSoundEnabled: z.boolean().optional()
})

router.patch('/', auth, requireRole('admin'), asyncHandler(async (req, res) => {
  const parsed = UpdateShopSettingsSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: parsed.error.flatten() })
    return
  }
  const current = await getOrCreateSettings()
  const { data } = parsed
  const updated = await prisma.shopSettings.update({ where: { id: current.id }, data })
  res.json(updated)
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
