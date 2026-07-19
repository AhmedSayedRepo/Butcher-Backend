import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/db'
import { auth } from '../middleware/auth'
import { asyncHandler } from '../lib/asyncHandler'
import { HTTP_STATUS } from '../lib/httpStatus'

const router = Router()

router.get('/', asyncHandler(async (_req, res) => {
  const products = await prisma.product.findMany({ orderBy: { name: 'asc' } })
  res.json(products)
}))

const MIN_NAME_LENGTH = 1

const CreateProduct = z.object({
  name: z.string().min(MIN_NAME_LENGTH),
  unit: z.string().default('kg'),
  pricePerKg: z.number().positive(),
  stockKg: z.number().nonnegative()
})

router.post('/', auth, asyncHandler(async (req, res) => {
  const parsed = CreateProduct.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: parsed.error.flatten() })
    return
  }

  const { data } = parsed
  const { name, unit, pricePerKg, stockKg } = data
  const product = await prisma.product.create({
    data: { name, unit, pricePerKg, stockKg }
  })
  res.status(HTTP_STATUS.CREATED).json(product)
}))

export default router
