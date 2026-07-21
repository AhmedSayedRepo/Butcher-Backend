import { Router } from 'express'
import { z } from 'zod'
import { OrderStatus } from '@prisma/client'
// `Prisma` is only referenced in the payload types below, so it's a type-only
// import — matches the pattern used in lib/dailyOrderNumber.ts.
import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/db.js'
import { auth } from '../middleware/auth.js'
import { requireCap } from '../middleware/rbac.js'
import type { AuthRequest } from '../middleware/auth.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'

// v3.1 follow-up 7 — editable drafts.
//
// Until now a draft was write-once: the only things you could do with one
// were promote it or cancel it, so a mistyped weight or a wrong customer
// meant cancelling and re-keying the whole order. These two routes fix that.
//
// Why this is safe to allow freely, and why it's DRAFT-ONLY: a draft has not
// touched stock (POST /api/orders/draft deliberately skips the decrement —
// stock moves at promote time) and has not written a cash-ledger entry. So
// editing or deleting one needs no stock reversal and no compensating
// CashTransaction, and can't corrupt the append-only ledger that ADR-011
// protects. The moment an order leaves DRAFT, both of those become true and
// editing it would mean unwinding real side effects — which is what the
// existing cancel-to-CANCELLED path already does properly. Hence the hard
// status guard in both handlers.
//
// Mounted on the same '/api/orders' prefix as routes/orders.ts in index.ts
// (Express allows multiple routers per prefix), keeping orders.ts under its
// max-lines limit — same split as routes/orderReceiptScan.ts.
const router = Router()

const MIN_ITEMS = 1
const MIN_KG = 0
const UNMATCHED_ITEM_PRICE = 0
const INITIAL_TOTAL = 0

// Every field optional: the frontend sends only what actually changed, so a
// customer-only edit doesn't have to round-trip the item list. `items`,
// when present, REPLACES the whole line-item set — the client always holds
// the full list while editing, and a replace is far less error-prone than a
// per-row add/update/remove patch protocol.
const EditDraftSchema = z.object({
  customer: z.string().nullable().optional(),
  customerId: z.string().nullable().optional(),
  customerMessage: z.string().nullable().optional(),
  deliveryAddress: z.string().nullable().optional(),
  deliveryName: z.string().nullable().optional(),
  // Not nullable, unlike the others: `paymentMethod` is a non-null column with
  // a "cash" default, so it can be changed but never cleared.
  paymentMethod: z.string().optional(),
  items: z.array(z.object({
    productId: z.string(),
    kg: z.number().positive().min(MIN_KG)
  })).min(MIN_ITEMS).optional()
})

// Return types are inferred from Prisma's generated payload types rather than
// hand-written — the include shape decides them, and restating it by hand would
// drift the moment the include changes.
type DraftWithItems = Prisma.OrderGetPayload<{ include: { items: true } }> | null
type OrderWithProducts = Prisma.OrderGetPayload<{
  include: { items: { include: { product: true } } }
}> | null

async function loadDraft(id: string): Promise<DraftWithItems> {
  return await prisma.order.findUnique({ where: { id }, include: { items: true } })
}

async function fullOrder(id: string): Promise<OrderWithProducts> {
  return await prisma.order.findUnique({
    where: { id },
    include: { items: { include: { product: true } } }
  })
}

// v3.1 follow-up 10d: same gate as creating a draft — editing or discarding
// one is the same authority.
router.patch('/:id', auth, requireCap('create_orders'), asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }
  const { params } = req
  const { id } = params

  const parsed = EditDraftSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: parsed.error.flatten() })
    return
  }
  const { data } = parsed

  const existing = await loadDraft(id)
  if (existing === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Order not found' })
    return
  }
  if (existing.status !== OrderStatus.DRAFT) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: 'Only draft orders can be edited. Confirmed orders have already moved stock — cancel it instead.'
    })
    return
  }

  const { items } = data

  // Prices are re-read from the product table rather than trusted from the
  // client, and re-read *now* rather than reused from the draft: a draft can
  // sit for hours, and the whole point of promoting it later is that it
  // settles at the current price. Same rule the create path follows.
  let total: number | undefined = undefined
  let priced: Array<{ productId: string, kg: number, price: number }> = []
  if (items !== undefined) {
    const products = await prisma.product.findMany({
      where: { id: { in: items.map((i) => i.productId) } }
    })
    const productMap = new Map(products.map((p) => [p.id, p]))
    for (const it of items) {
      if (!productMap.has(it.productId)) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({ error: `Product not found: ${it.productId}` })
        return
      }
    }
    priced = items.map((it) => {
      const p = productMap.get(it.productId)
      const unit = p === undefined ? UNMATCHED_ITEM_PRICE : Number(p.pricePerKg)
      return { productId: it.productId, kg: it.kg, price: unit * it.kg }
    })
    total = priced.reduce((sum, it) => sum + it.price, INITIAL_TOTAL)
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id },
      data: {
        customer: data.customer,
        customerId: data.customerId,
        customerMessage: data.customerMessage,
        deliveryAddress: data.deliveryAddress,
        deliveryName: data.deliveryName,
        paymentMethod: data.paymentMethod,
        ...(total === undefined ? {} : { totalAmount: total })
      }
    })
    if (items !== undefined) {
      // Replace wholesale. Safe here precisely because no stock ever moved
      // for these rows — see the file header.
      await tx.orderItem.deleteMany({ where: { orderId: id } })
      await tx.orderItem.createMany({
        data: priced.map((it) => ({ orderId: id, productId: it.productId, kg: it.kg, price: it.price }))
      })
    }
  })

  res.json(await fullOrder(id))
}))

// Hard delete, drafts only. Deliberately NOT the same thing as cancelling:
// a cancelled order is a real record of something that happened and stays in
// the history; a draft that was never confirmed is just a half-finished note,
// and keeping a CANCELLED row for every mistyped draft would clutter the
// board and the reports for no informational gain.
router.delete('/:id', auth, requireCap('create_orders'), asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }
  const { params } = req
  const { id } = params

  const existing = await loadDraft(id)
  if (existing === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Order not found' })
    return
  }
  if (existing.status !== OrderStatus.DRAFT) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: 'Only draft orders can be deleted. Cancel a confirmed order instead.'
    })
    return
  }

  await prisma.$transaction(async (tx) => {
    await tx.orderItem.deleteMany({ where: { orderId: id } })
    await tx.orderStatusEvent.deleteMany({ where: { orderId: id } })
    await tx.order.delete({ where: { id } })
  })

  res.status(HTTP_STATUS.NO_CONTENT).send()
}))

export default router
