import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/db.js'
import { auth } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'

const router = Router()

const MIN_ORDER_ITEMS = 1
const INITIAL_TOTAL = 0

const OrderItemSchema = z.object({
  productId: z.string().uuid(),
  kg: z.number().positive()
})

const CreateOrderSchema = z.object({
  customer: z.string().optional(),
  items: z.array(OrderItemSchema).min(MIN_ORDER_ITEMS)
})

router.get('/', auth, asyncHandler(async (_req, res) => {
  const orders = await prisma.order.findMany({
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
  res.status(HTTP_STATUS.CREATED).json(full)
}))

export default router
