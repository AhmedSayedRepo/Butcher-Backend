import { Router } from 'express'
import { z } from 'zod'
import { OrderStatus } from '@prisma/client'
import { prisma } from '../lib/db.js'
import { auth } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import { requireCap } from '../middleware/rbac.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'
import { fireWebhook } from '../lib/webhook.js'
import { isLowStock } from '../lib/lowStock.js'

const router = Router()

const MIN_ORDER_ITEMS = 1
const INITIAL_TOTAL = 0
const UNMATCHED_ITEM_PRICE = 0

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

router.post('/', auth, asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }
  const { user } = req

  const parsed = CreateOrderSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: parsed.error.flatten() })
    return
  }

  const { data } = parsed
  const { customer, items } = data

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
    const created = await tx.order.create({
      data: {
        customer,
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

    return created
  })

  const full = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } })
  void fireWebhook({
    type: 'order.created',
    orderId: order.id,
    customer: customer ?? null,
    totalAmount: total.toString()
  })
  void notifyIfLowStock(productIds)
  res.status(HTTP_STATUS.CREATED).json(full)
}))

// v2 replan (Phase C): "card draft items" — a cashier can start building an
// order, save it without touching stock, and come back to it (or another
// cashier can) before committing it via POST /:id/promote. Deliberately does
// NOT validate stock sufficiency here (only that each productId is real) —
// stock is re-checked at promote time, since it may have changed by then;
// see the plan's Phase C section for why.
router.post('/draft', auth, asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }
  const { user } = req

  const parsed = CreateOrderSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: parsed.error.flatten() })
    return
  }
  const { data } = parsed
  const { customer, items } = data

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
    const created = await tx.order.create({
      data: {
        customer,
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
  res.status(HTTP_STATUS.CREATED).json(full)
}))

// v2 replan (Phase C): promotes a DRAFT order to CREATED — re-validates
// stock (it may have changed since the draft was saved) and runs the same
// stock-decrement transaction the direct-create path above uses.
router.post('/:id/promote', auth, asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }
  const { user } = req
  const { params } = req
  const { id } = params

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
  })

  const full = await prisma.order.findUnique({ where: { id }, include: { items: true } })
  void fireWebhook({
    type: 'order.created',
    orderId: id,
    customer: existing.customer,
    totalAmount: existing.totalAmount.toString()
  })
  void notifyIfLowStock(productIds)
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

  const existing = await prisma.order.findUnique({ where: { id } })
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
  })

  void fireWebhook({
    type: 'order.status_changed',
    orderId: id,
    status: nextStatus,
    previousStatus
  })

  const full = await prisma.order.findUnique({ where: { id }, include: { items: true } })
  res.json(full)
}))

export default router
