import { Router } from 'express'
import { prisma } from '../lib/db'
import { z } from 'zod'
import { auth } from '../middleware/auth'

const router = Router()

router.get('/', async (_req, res) => {
  const products = await prisma.product.findMany({ orderBy: { name: 'asc' } })
  res.json(products)
})

const CreateProduct = z.object({
  name: z.string().min(1),
  unit: z.string().default('kg'),
  pricePerKg: z.number().positive(),
  stockKg: z.number().nonnegative()
})

router.post('/', auth, async (req, res) => {
  const parsed = CreateProduct.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const p = parsed.data
  const product = await prisma.product.create({
    data: {
      name: p.name,
      unit: p.unit,
      pricePerKg: p.pricePerKg,
      stockKg: p.stockKg
    }
  })
  res.status(201).json(product)
})

export default router
