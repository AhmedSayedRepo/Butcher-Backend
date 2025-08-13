import { Router } from 'express'

const router = Router()

router.post('/', (req, res) => {
  const { message } = req.body || {}
  const items: { product_name: string, requested_kg: number }[] = []

  ;(message || '').toLowerCase()
    .split(/and|,|;/)
    .map((t: string) => t.trim())
    .filter(Boolean)
    .forEach((t: string) => {
      const m = t.match(/([0-9]*\.?[0-9]+)\s*kg\s*(.+)/)
      if (m) items.push({ product_name: m[2].trim(), requested_kg: parseFloat(m[1]) })
    })

  res.json({ items, clarification_needed: items.length === 0 })
})

export default router
