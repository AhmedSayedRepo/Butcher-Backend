import { Router } from 'express'
import { z } from 'zod'
import { CashTransactionType, OrderStatus } from '@prisma/client'
import { prisma } from '../lib/db.js'
import { auth } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import { requireCap } from '../middleware/rbac.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'
import { findIdempotentResponse, storeIdempotentResponse, idempotencyKeyFrom, toIdempotentJson } from '../lib/idempotency.js'

const router = Router()

// v3 replan (Phase K — cash management). Everything here is gated by the
// dedicated `manage_cash` capability (ADR-012), not `manage_orders` — a
// cashier who can ring up a sale shouldn't automatically see the drawer
// ledger or be able to log arbitrary in/out entries.
router.use(auth, requireCap('manage_cash'))

router.get('/', asyncHandler(async (req, res) => {
  const { query } = req
  const { from, to } = query
  const where: { createdAt?: { gte?: Date, lte?: Date } } = {}
  if (typeof from === 'string' && from !== '') {
    where.createdAt = { ...where.createdAt, gte: new Date(from) }
  }
  if (typeof to === 'string' && to !== '') {
    where.createdAt = { ...where.createdAt, lte: new Date(to) }
  }
  const transactions = await prisma.cashTransaction.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { email: true } } }
  })
  res.json(transactions)
}))

const MIN_CATEGORY_LENGTH = 1

const CreateCashTransactionSchema = z.object({
  type: z.nativeEnum(CashTransactionType),
  category: z.string().min(MIN_CATEGORY_LENGTH),
  amount: z.number().positive(),
  note: z.string().optional()
})

const IDEMPOTENCY_ENDPOINT = 'POST /api/cash-transactions'

// Manual entries: owner deposits, supplier payments, petty cash, till
// corrections. Append-only (ADR-011) — no PATCH/DELETE; a mistaken entry is
// corrected by inserting the opposite-signed entry, same idea as
// StockAdjustment elsewhere in this codebase.
router.post('/', asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }
  const { user, headers } = req
  const idempotencyKey = idempotencyKeyFrom(headers)

  const cached = await findIdempotentResponse(IDEMPOTENCY_ENDPOINT, idempotencyKey)
  if (cached !== undefined) {
    res.status(HTTP_STATUS.CREATED).json(cached)
    return
  }

  const parsed = CreateCashTransactionSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: parsed.error.flatten() })
    return
  }
  const { data } = parsed
  const transaction = await prisma.cashTransaction.create({
    data: { ...data, userId: user.id }
  })

  await storeIdempotentResponse(IDEMPOTENCY_ENDPOINT, idempotencyKey, toIdempotentJson(transaction))
  res.status(HTTP_STATUS.CREATED).json(transaction)
}))

const DAY_RANGE_DAYS = 1
const WEEK_RANGE_DAYS = 7
const MONTH_RANGE_DAYS = 30
const YEAR_RANGE_DAYS = 365
const RANGE_TO_DAYS: Record<string, number> = { day: DAY_RANGE_DAYS, week: WEEK_RANGE_DAYS, month: MONTH_RANGE_DAYS, year: YEAR_RANGE_DAYS }
const DEFAULT_RANGE_DAYS = WEEK_RANGE_DAYS
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
const MS_PER_DAY = MS_PER_SECOND * SECONDS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY
const ZERO = 0
const CURRENCY_DECIMALS = 2

// v3 replan (Phase K reporting screen). Keeps cash position (this ledger)
// and total revenue (Order.totalAmount) as two separate, never-merged
// figures per ADR-011 — they answer different questions (what's physically
// in the drawer vs. what was sold) and conflating them would misstate both.
router.get('/summary', asyncHandler(async (req, res) => {
  const { query } = req
  const { range } = query
  const rangeKey = typeof range === 'string' ? range : 'week'
  const days = RANGE_TO_DAYS[rangeKey] ?? DEFAULT_RANGE_DAYS
  const since = new Date(Date.now() - days * MS_PER_DAY)

  const transactions = await prisma.cashTransaction.findMany({ where: { createdAt: { gte: since } } })
  const cashIn = transactions
    .filter((t) => t.type === CashTransactionType.IN)
    .reduce((sum, t) => sum + Number(t.amount), ZERO)
  const cashOut = transactions
    .filter((t) => t.type === CashTransactionType.OUT)
    .reduce((sum, t) => sum + Number(t.amount), ZERO)

  // Revenue counts every real (non-draft, non-cancelled) order regardless of
  // payment method — a card/other-method sale is still revenue even though
  // it never touches this cash ledger.
  const orders = await prisma.order.findMany({
    where: {
      createdAt: { gte: since },
      status: { notIn: [OrderStatus.DRAFT, OrderStatus.CANCELLED] }
    }
  })
  const totalRevenue = orders.reduce((sum, o) => sum + Number(o.totalAmount), ZERO)

  res.json({
    cashIn: cashIn.toFixed(CURRENCY_DECIMALS),
    cashOut: cashOut.toFixed(CURRENCY_DECIMALS),
    netPosition: (cashIn - cashOut).toFixed(CURRENCY_DECIMALS),
    totalRevenue: totalRevenue.toFixed(CURRENCY_DECIMALS)
  })
}))

export default router
