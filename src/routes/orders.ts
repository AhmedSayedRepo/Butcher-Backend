import { Router } from 'express'
import { z } from 'zod'
import { OrderStatus, CashTransactionType } from '@prisma/client'
import { prisma } from '../lib/db.js'
import { auth } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import { requireCap } from '../middleware/rbac.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'
import { fireWebhook } from '../lib/webhook.js'
import { isLowStock } from '../lib/lowStock.js'
import { findIdempotentResponse, storeIdempotentResponse, idempotencyKeyFrom, toIdempotentJson } from '../lib/idempotency.js'
import { nextDailyOrderNumber } from '../lib/dailyOrderNumber.js'

const router = Router()

const MIN_ORDER_ITEMS = 1
const INITIAL_TOTAL = 0
const UNMATCHED_ITEM_PRICE = 0

// v3 replan (Phase I — omnichannel intake). Extends the set of `source`
// values the app understands — `source` stays a free-text column (not a DB
// enum, per the v3 plan), so this is a zero-migration, zod-only change.
// `cashier`/`whatsapp` already existed (v2/Phase G); `in_premise`/`social`/
// `phone` are new this phase.
const SOURCE_VALUES = ['cashier', 'whatsapp', 'in_premise', 'social', 'phone'] as const

// v3 replan (Phase K — cash management, ADR-011). Auto-logs a matching
// CashTransaction the moment an order becomes a real, stock-decremented sale
// (direct POST / or POST /:id/promote) with paymentMethod "cash" — never at
// draft-save time, since a draft hasn't actually happened yet. Runs inside
// the *same* prisma.$transaction as the order write per the plan's
// transactional-integrity rule, so the order and the cash-ledger entry
// always succeed or fail together.
//
// v3.1 follow-up: category now embeds the order's channel/source
// ("sale (in_premise)", "sale (whatsapp)"...) instead of a flat "sale" for
// every order, so the cash ledger table itself shows where the money came
// from without opening each order individually.
function saleCategory(source: string): string {
  return `sale (${source})`
}

// v3.1 follow-up: cancelling an order previously left its stock decrement
// and auto-logged cash-in entry in place forever — cancelling never "gave
// back" the ingredients or reversed the sale. Fixed in PATCH /:id/status
// below. The reversal is a new OUT entry, never an edit/delete of the
// original IN row, per ADR-011's append-only-ledger rule.
const SALE_REVERSAL_CATEGORY = 'sale_reversal (cancelled)'

// `status as OrderStatus` was an unsafe assertion — `x in EnumObject` narrows
// membership but not to the enum's own type. This is a real runtime type
// guard instead, so callers get proper narrowing with no cast.
function isOrderStatus(value: string): value is OrderStatus {
  return Object.values(OrderStatus).some((v) => v === value)
}

const OrderItemSchema = z.object({
  productId: z.string().uuid(),
  kg: z.number().positive()
})

const CreateOrderSchema = z.object({
  customer: z.string().optional(),
  // v3 replan (Phase H — CRM): optional link to a real Customer record.
  // The free-text `customer` field above is untouched — both can be set
  // independently, nothing about the pre-v3 order flow changes.
  customerId: z.string().uuid().optional(),
  // v3 replan (Phase I.2/I.3 — social & phone intake, ADR-009). Verbatim DM
  // text or call notes, staff-entered — same field Phase G's WhatsApp
  // webhook already writes to directly for bot-created drafts; this is the
  // human-entry path onto the same column.
  customerMessage: z.string().optional(),
  // v3 replan (Phase I.3 — phone delivery orders). Null/omitted for every
  // other source.
  deliveryAddress: z.string().optional(),
  // v3 replan (Phase K — cash management). Defaults to "cash" so every
  // pre-v3 order-creation call (no body change required) still gets a
  // correct value.
  paymentMethod: z.string().default('cash'),
  source: z.enum(SOURCE_VALUES).optional(),
  items: z.array(OrderItemSchema).min(MIN_ORDER_ITEMS)
})

// Shared by the direct-create and promote-from-draft paths below: after
// stock has been decremented for a set of productIds, fire a
// `product.low_stock` webhook (Phase F) for any that crossed the threshold.
// Fire-and-forget (see lib/webhook.ts) — never blocks or fails the request.
async function notifyIfLowStock(productIds: string[]): Promise<void> {
  const updated = await prisma.product.findMany({ where: { id: { in: productIds } } })
  for (const p of updated) {
    if (isLowStock(p)) {
      void fireWebhook({
        type: 'product.low_stock',
        productId: p.id,
        name: p.name,
        stockKg: p.stockKg.toString(),
        thresholdKg: (p.lowStockAlertKg ?? '').toString()
      })
    }
  }
}

// v2 replan (Phase C): the kanban board wants orders grouped by status —
// optional ?status=IN_PROGRESS filter, additive (no query param still
// returns everything, same as before).
router.get('/', auth, asyncHandler(async (req, res) => {
  const { query } = req
  const { status } = query
  const where = typeof status === 'string' && isOrderStatus(status)
    ? { status }
    : {}
  const orders = await prisma.order.findMany({
    where,
    include: { items: true },
    orderBy: { createdAt: 'desc' }
  })
  res.json(orders)
}))

const CREATE_ORDER_ENDPOINT = 'POST /api/orders'

router.post('/', auth, asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }
  const { user, headers } = req
  const idempotencyKey = idempotencyKeyFrom(headers)

  // v3 replan — idempotency guard (real gap flagged in
  // Butcher-Project-Plan-v3.md): a barcode scanner double-firing or a
  // cashier re-tapping "Submit" under time pressure could otherwise
  // double-decrement stock and double-create an order.
  const cached = await findIdempotentResponse(CREATE_ORDER_ENDPOINT, idempotencyKey)
  if (cached !== undefined) {
    res.status(HTTP_STATUS.CREATED).json(cached)
    return
  }

  const parsed = CreateOrderSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: parsed.error.flatten() })
    return
  }

  const { data } = parsed
  const { customer, customerId, customerMessage, deliveryAddress, paymentMethod, source, items } = data
  // The zod schema leaves `source` optional; the DB column defaults it to
  // "cashier" for us, but the cash-ledger category string is built in JS
  // before that default is visible on any object we hold, so resolve it
  // here too — same value either way.
  const DEFAULT_SOURCE = 'cashier'
  const resolvedSource = source ?? DEFAULT_SOURCE

  const productIds = items.map((i) => i.productId)
  const products = await prisma.product.findMany({ where: { id: { in: productIds } } })
  const productMap = new Map(products.map((p) => [p.id, p]))

  // Every item's productId is confirmed to exist in productMap by the
  // validation loop below before this is ever called, so reaching the
  // `undefined` branch here means an internal invariant was violated, not a
  // client error — throwing (rather than a non-null assertion) lets
  // asyncHandler forward it to the centralized error handler as a proper 500
  // instead of silently continuing with bad data.
  function getProduct(productId: string): (typeof products)[number] {
    const p = productMap.get(productId)
    if (p === undefined) {
      throw new Error(`Product not found: ${productId}`)
    }
    return p
  }

  for (const it of items) {
    const p = productMap.get(it.productId)
    if (p === undefined) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ error: `Product not found: ${it.productId}` })
      return
    }
    if (Number(p.stockKg) < it.kg) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: `Insufficient stock for ${p.name}. Available: ${p.stockKg.toString()} kg`
      })
      return
    }
  }

  const total = items.reduce((sum, it) => {
    const p = getProduct(it.productId)
    return sum + Number(p.pricePerKg) * it.kg
  }, INITIAL_TOTAL)

  const order = await prisma.$transaction(async (tx) => {
    // v3.1 replan (Phase L — daily order numbering, ADR-015): a
    // human-friendly "#N" sequence, reset by the closing-day action, sits
    // alongside the real uuid `id` (still the FK/primary key everywhere) —
    // assigned atomically inside this same transaction so two concurrent
    // submits can never collide on the same number.
    const dailyNumber = await nextDailyOrderNumber(tx)
    const created = await tx.order.create({
      data: {
        customer,
        customerId,
        customerMessage,
        deliveryAddress,
        paymentMethod,
        source,
        dailyNumber,
        totalAmount: total,
        userId: user.id
      }
    })

    // v2 replan (Phase C): every order gets its CREATED transition recorded
    // from the start, not just ones that later move through PATCH
    // /:id/status — so the kanban board's timeline is complete for every
    // order, including ones created the old one-shot way.
    await tx.orderStatusEvent.create({
      data: { orderId: created.id, status: OrderStatus.CREATED, changedBy: user.id }
    })

    await Promise.all(items.map(async (it) => {
      const p = getProduct(it.productId)
      await tx.orderItem.create({
        data: {
          orderId: created.id,
          productId: it.productId,
          kg: it.kg,
          price: Number(p.pricePerKg) * it.kg
        }
      })
      await tx.product.update({
        where: { id: it.productId },
        data: { stockKg: Number(p.stockKg) - it.kg }
      })
    }))

    // v3 replan (Phase K, ADR-011): a real, stock-decremented cash sale logs
    // itself into the drawer ledger in the same transaction — never a
    // separate follow-up call that could fail independently.
    if (paymentMethod === 'cash') {
      await tx.cashTransaction.create({
        data: { type: CashTransactionType.IN, category: saleCategory(resolvedSource), amount: total, userId: user.id, note: `Order #${dailyNumber}` }
      })
    }

    return created
  })

  const full = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } })
  void fireWebhook({
    type: 'order.created',
    orderId: order.id,
    orderNumber: order.dailyNumber,
    customer: customer ?? null,
    totalAmount: total.toString(),
    items: items.map((it) => ({ itemName: getProduct(it.productId).name, kg: it.kg.toString() }))
  })
  void notifyIfLowStock(productIds)
  await storeIdempotentResponse(CREATE_ORDER_ENDPOINT, idempotencyKey, toIdempotentJson(full))
  res.status(HTTP_STATUS.CREATED).json(full)
}))

// v2 replan (Phase C): "card draft items" — a cashier can start building an
// order, save it without touching stock, and come back to it (or another
// cashier can) before committing it via POST /:id/promote. Deliberately does
// NOT validate stock sufficiency here (only that each productId is real) —
// stock is re-checked at promote time, since it may have changed by then;
// see the plan's Phase C section for why.
const CREATE_DRAFT_ENDPOINT = 'POST /api/orders/draft'

router.post('/draft', auth, asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }
  const { user, headers } = req
  const idempotencyKey = idempotencyKeyFrom(headers)

  const cached = await findIdempotentResponse(CREATE_DRAFT_ENDPOINT, idempotencyKey)
  if (cached !== undefined) {
    res.status(HTTP_STATUS.CREATED).json(cached)
    return
  }

  const parsed = CreateOrderSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: parsed.error.flatten() })
    return
  }
  const { data } = parsed
  const { customer, customerId, customerMessage, deliveryAddress, paymentMethod, source, items } = data

  const productIds = items.map((i) => i.productId)
  const products = await prisma.product.findMany({ where: { id: { in: productIds } } })
  const productMap = new Map(products.map((p) => [p.id, p]))

  for (const it of items) {
    if (!productMap.has(it.productId)) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ error: `Product not found: ${it.productId}` })
      return
    }
  }

  const total = items.reduce((sum, it) => {
    const p = productMap.get(it.productId)
    return sum + (p === undefined ? UNMATCHED_ITEM_PRICE : Number(p.pricePerKg) * it.kg)
  }, INITIAL_TOTAL)

  const draft = await prisma.$transaction(async (tx) => {
    // Drafts get a daily number too (Phase L, ADR-015) — they're already
    // real, visible cards on the Inbox/kanban board, and promoting one
    // later keeps the same number rather than reassigning.
    const dailyNumber = await nextDailyOrderNumber(tx)
    const created = await tx.order.create({
      data: {
        customer,
        customerId,
        customerMessage,
        deliveryAddress,
        paymentMethod,
        source,
        dailyNumber,
        totalAmount: total,
        userId: user.id,
        status: OrderStatus.DRAFT
      }
    })
    await tx.orderStatusEvent.create({
      data: { orderId: created.id, status: OrderStatus.DRAFT, changedBy: user.id }
    })
    await Promise.all(items.map(async (it) => {
      const p = productMap.get(it.productId)
      await tx.orderItem.create({
        data: {
          orderId: created.id,
          productId: it.productId,
          kg: it.kg,
          price: (p === undefined ? UNMATCHED_ITEM_PRICE : Number(p.pricePerKg)) * it.kg
        }
      })
    }))
    return created
  })

  const full = await prisma.order.findUnique({ where: { id: draft.id }, include: { items: true } })
  await storeIdempotentResponse(CREATE_DRAFT_ENDPOINT, idempotencyKey, toIdempotentJson(full))
  res.status(HTTP_STATUS.CREATED).json(full)
}))

// v2 replan (Phase C): promotes a DRAFT order to CREATED — re-validates
// stock (it may have changed since the draft was saved) and runs the same
// stock-decrement transaction the direct-create path above uses.
const PROMOTE_ORDER_ENDPOINT = 'POST /api/orders/:id/promote'

router.post('/:id/promote', auth, asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }
  const { user, headers } = req
  const { params } = req
  const { id } = params
  // Endpoint key includes the order id: a retried promote of order A must
  // not replay order B's cached response if the two happened to share a
  // client-generated Idempotency-Key (shouldn't happen with proper
  // per-attempt UUIDs, but scoping by id costs nothing and removes the
  // possibility entirely).
  const idempotencyKey = idempotencyKeyFrom(headers)
  const cached = await findIdempotentResponse(`${PROMOTE_ORDER_ENDPOINT}:${id}`, idempotencyKey)
  if (cached !== undefined) {
    res.json(cached)
    return
  }

  const existing = await prisma.order.findUnique({ where: { id }, include: { items: true } })
  if (existing === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Order not found' })
    return
  }
  if (existing.status !== OrderStatus.DRAFT) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Only draft orders can be promoted' })
    return
  }

  const productIds = existing.items.map((it) => it.productId)
  const products = await prisma.product.findMany({ where: { id: { in: productIds } } })
  const productMap = new Map(products.map((p) => [p.id, p]))

  for (const it of existing.items) {
    const p = productMap.get(it.productId)
    if (p === undefined) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ error: `Product not found: ${it.productId}` })
      return
    }
    if (Number(p.stockKg) < Number(it.kg)) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: `Insufficient stock for ${p.name}. Available: ${p.stockKg.toString()} kg`
      })
      return
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id }, data: { status: OrderStatus.CREATED } })
    await tx.orderStatusEvent.create({
      data: { orderId: id, status: OrderStatus.CREATED, changedBy: user.id }
    })
    await Promise.all(existing.items.map(async (it) => {
      const p = productMap.get(it.productId)
      if (p === undefined) return
      await tx.product.update({
        where: { id: it.productId },
        data: { stockKg: Number(p.stockKg) - Number(it.kg) }
      })
    }))

    // v3 replan (Phase K, ADR-011): promoting a draft is the moment it
    // becomes a real, stock-decremented sale — same rule as the direct
    // POST / path above, kept in sync deliberately (see saleCategory()).
    if (existing.paymentMethod === 'cash') {
      await tx.cashTransaction.create({
        data: { type: CashTransactionType.IN, category: saleCategory(existing.source), amount: existing.totalAmount, userId: user.id, note: `Order #${existing.dailyNumber ?? '?'}` }
      })
    }
  })

  const full = await prisma.order.findUnique({ where: { id }, include: { items: true } })
  void fireWebhook({
    type: 'order.created',
    orderId: id,
    orderNumber: existing.dailyNumber,
    customer: existing.customer,
    totalAmount: existing.totalAmount.toString(),
    items: existing.items.map((it) => ({ itemName: productMap.get(it.productId)?.name ?? 'Unknown', kg: it.kg.toString() }))
  })
  void notifyIfLowStock(productIds)
  await storeIdempotentResponse(`${PROMOTE_ORDER_ENDPOINT}:${id}`, idempotencyKey, toIdempotentJson(full))
  res.json(full)
}))

const PROMOTABLE_STATUSES: readonly OrderStatus[] = [
  OrderStatus.IN_PROGRESS,
  OrderStatus.ON_THE_WAY,
  OrderStatus.IN_PREMISE,
  OrderStatus.CANCELLED
]

const UpdateStatusSchema = z.object({
  status: z.enum(['IN_PROGRESS', 'ON_THE_WAY', 'IN_PREMISE', 'CANCELLED'])
})

// v2 replan (Phase C): moves a card between kanban columns. DRAFT→CREATED
// only happens via /promote above, not here — see PROMOTABLE_STATUSES.
// Gated by `manage_orders` (lib/caps.ts) rather than plain `auth`: changing
// an order's fulfillment status is a step up from just creating one.
router.patch('/:id/status', auth, requireCap('manage_orders'), asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }
  const { user } = req
  const { params } = req
  const { id } = params

  const parsed = UpdateStatusSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: parsed.error.flatten() })
    return
  }
  const { data } = parsed
  const { status: nextStatusKey } = data
  const { [nextStatusKey]: nextStatus } = OrderStatus

  if (!PROMOTABLE_STATUSES.includes(nextStatus)) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: `Cannot set status to ${nextStatus} here` })
    return
  }

  const existing = await prisma.order.findUnique({
    where: { id },
    include: { items: { include: { product: true } } }
  })
  if (existing === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Order not found' })
    return
  }
  if (existing.status === OrderStatus.DRAFT) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Promote the draft first with POST /:id/promote' })
    return
  }
  if (existing.status === OrderStatus.CANCELLED) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'This order is cancelled' })
    return
  }

  const previousStatus: OrderStatus = existing.status
  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id }, data: { status: nextStatus } })
    await tx.orderStatusEvent.create({
      data: { orderId: id, status: nextStatus, changedBy: user.id }
    })

    // v3.1 bug fix: cancelling an order previously left its ingredients
    // "sold" forever — the stock decrement from creation/promotion time was
    // never reversed. CANCELLED is only reachable from here once every
    // other status (CREATED/IN_PROGRESS/ON_THE_WAY/IN_PREMISE, guarded
    // above against DRAFT and re-cancelling), all of which already
    // decremented stock — so it's always correct to give it back now.
    // `increment` is a DB-side atomic op, not a JS read-then-write, so this
    // is safe to run concurrently across items even if two line items
    // happen to share a productId.
    if (nextStatus === OrderStatus.CANCELLED) {
      await Promise.all(existing.items.map(async (it) => {
        await tx.product.update({
          where: { id: it.productId },
          data: { stockKg: { increment: Number(it.kg) } }
        })
      }))

      // Reverses the auto-logged sale entry too, so a cancelled order stops
      // counting as cash in the drawer. Per ADR-011's append-only ledger
      // rule, this is a new OUT entry — the original IN row is never
      // edited or deleted.
      if (existing.paymentMethod === 'cash') {
        await tx.cashTransaction.create({
          data: {
            type: CashTransactionType.OUT,
            category: SALE_REVERSAL_CATEGORY,
            amount: existing.totalAmount,
            userId: user.id,
            note: `Cancelled order #${existing.dailyNumber ?? '?'}`
          }
        })
      }
    }
  })

  void fireWebhook({
    type: 'order.status_changed',
    orderId: id,
    orderNumber: existing.dailyNumber,
    customer: existing.customer,
    totalAmount: existing.totalAmount.toString(),
    items: existing.items.map((it) => ({ itemName: it.product.name, kg: it.kg.toString() })),
    status: nextStatus,
    previousStatus
  })

  const full = await prisma.order.findUnique({ where: { id }, include: { items: true } })
  res.json(full)
}))

export default router
