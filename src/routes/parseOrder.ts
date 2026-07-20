import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../lib/asyncHandler.js'
import { parseOrderMessage } from '../lib/parseOrderMessage.js'

const router = Router()

const ParseOrderSchema = z.object({
  message: z.string().optional()
})

// Parsing itself now lives in lib/parseOrderMessage.ts (Phase I.2) — shared
// with the WhatsApp inbound webhook — this route is just the HTTP wrapper
// staff use to try a message manually before it goes live.
router.post('/', asyncHandler(async (req, res) => {
  const parsed = ParseOrderSchema.safeParse(req.body)
  const message = parsed.success ? parsed.data.message ?? '' : ''

  const { items, clarificationNeeded } = await parseOrderMessage(message)
  res.json({ items, clarification_needed: clarificationNeeded })
}))

export default router
