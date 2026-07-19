import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/db'
import { asyncHandler } from '../lib/asyncHandler'

const router = Router()

const EMPTY_ITEMS_LENGTH = 0

const ParseOrderSchema = z.object({
  message: z.string().optional()
})

// Phase 4, part 1: Arabic-Indic digits (٠-٩) are remapped to ASCII before
// parsing, so `parseFloat` and the amount regex below work identically
// regardless of which script the amount was written in. This only
// translates the digit *script* — it doesn't parse spelled-out numeral
// words in either language (e.g. "two", "اثنين").
const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'
function normalizeDigits(text: string): string {
  return text.replace(/[٠-٩]/gv, (d) => ARABIC_INDIC_DIGITS.indexOf(d).toString())
}

// Named capture groups (required by prefer-named-capture-group) and the 'v'
// flag (required by require-unicode-regexp — see backend/package.json's
// engines bump to Node >=20 for why 'v' rather than 'u'). Recognizes the
// English "kg" plus the common Arabic weight-unit spellings.
const KG_PATTERN = /(?<amount>[0-9]*\.?[0-9]+)\s*(?:kg|كيلو|كجم|كغم)\s*(?<name>.+)/v

// Splits on English "and"/","/";" and the Arabic comma "،". Deliberately
// does NOT split on a bare Arabic "و" ("and") — in real usage it's almost
// always written attached to the next word with no space (e.g.
// "لحم وكيلو دجاج"), so treating it as a delimiter would corrupt words
// rather than separate order items.
const SEPARATOR_PATTERN = /and|,|;|،/v

interface ParsedItem {
  product_name: string
  requested_kg: number
  productId: string | null
  pricePerKg: string | null
}

function normalizeForMatch(text: string): string {
  return text.trim().toLowerCase()
}

router.post('/', asyncHandler(async (req, res) => {
  const parsed = ParseOrderSchema.safeParse(req.body)
  const message = parsed.success ? parsed.data.message ?? '' : ''

  // Phase 4, part 2: match parsed names against the real catalog and attach
  // productId — previously this endpoint only ever returned free-text names,
  // leaving the caller to guess which product (if any) was meant.
  const catalog = await prisma.product.findMany()

  const items: ParsedItem[] = []

  normalizeDigits(message)
    .toLowerCase()
    .split(SEPARATOR_PATTERN)
    .map((t) => t.trim())
    .filter(Boolean)
    .forEach((t) => {
      const m = KG_PATTERN.exec(t)
      if (m?.groups === undefined) return

      const { groups } = m
      const { amount, name } = groups
      const trimmedName = name.trim()
      const parsedName = normalizeForMatch(trimmedName)
      const match = catalog.find((p) => {
        const productName = normalizeForMatch(p.name)
        return productName.includes(parsedName) || parsedName.includes(productName)
      })

      items.push({
        product_name: trimmedName,
        requested_kg: parseFloat(amount),
        productId: match?.id ?? null,
        pricePerKg: match === undefined ? null : match.pricePerKg.toString()
      })
    })

  const hasUnmatchedItem = items.some((i) => i.productId === null)
  res.json({
    items,
    clarification_needed: items.length === EMPTY_ITEMS_LENGTH || hasUnmatchedItem
  })
}))

export default router
