import { Router } from 'express'
import { z } from 'zod'

const router = Router()

const EMPTY_ITEMS_LENGTH = 0

const ParseOrderSchema = z.object({
  message: z.string().optional()
})

// Named capture groups (required by prefer-named-capture-group) and the 'v'
// flag (required by require-unicode-regexp — see backend/package.json's
// engines bump to Node >=20 for why 'v' rather than 'u').
const KG_PATTERN = /(?<amount>[0-9]*\.?[0-9]+)\s*kg\s*(?<name>.+)/v

router.post('/', (req, res) => {
  const parsed = ParseOrderSchema.safeParse(req.body)
  const message = parsed.success ? parsed.data.message ?? '' : ''

  const items: Array<{ product_name: string, requested_kg: number }> = []

  message
    .toLowerCase()
    .split(/and|,|;/v)
    .map((t) => t.trim())
    .filter(Boolean)
    .forEach((t) => {
      const m = KG_PATTERN.exec(t)
      if (m?.groups !== undefined) {
        const { groups } = m
        const { amount, name } = groups
        items.push({ product_name: name.trim(), requested_kg: parseFloat(amount) })
      }
    })

  res.json({ items, clarification_needed: items.length === EMPTY_ITEMS_LENGTH })
})

export default router
