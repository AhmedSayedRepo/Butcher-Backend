import { Router } from 'express'
import { prisma } from '../lib/db'
import { z } from 'zod'
import { auth, AuthRequest } from '../middleware/auth'

const router = Router()

const OrderItemSchema = z.object({
  productId: z.string().uuid(),
  kg: z.number().positive()
})

const CreateOrderSchema = z.object({
  customer: z.string().optional(),
  items: z.array(OrderItemSchema).min(1)
})

router.get('/', auth, async (_req, res) => {
  const orders = await prisma.order.findMany({
    include: { items: true },
    orderBy: { createdAt: 'desc' }
  })
  res.json(orders)
})

router.post('/', auth, async (req: AuthRequest, res) => {
  const parsed = CreateOrderSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { customer, items } = parsed.data

  const productIds = items.map(i => i.productId)
  const products = await prisma.product.findMany({ where: { id: { in: productIds } } })
  const productMap = new Map(products.map(p => [p.id, p]))

  for (const it of items) {
    const p = productMap.get(it.productId)
    if (!p) return res.status(400).json({ error: `Product not found: ${it.productId}` })
    if (Number(p.stockKg) < it.kg) {
      return res.status(400).json({ error: `Insufficient stock for ${p.name}. Available: ${p.stockKg} kg` })
    }
  }

  const total = items.reduce((sum, it) => {
    const p = productMap.get(it.productId)!
    return sum + Number(p.pricePerKg) * it.kg
  }, 0)

  const order = await prisma.$transaction(async (tx) => {
    const created = await tx.order.create({
      data: {
        customer,
        totalAmount: total,
        userId: (req.user as any).id
      }
    })

    for (const it of items) {
      const p = productMap.get(it.productId)!
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
    }

    return created
  })

  const full = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } })
  res.status(201).json(full)
})

export default router
