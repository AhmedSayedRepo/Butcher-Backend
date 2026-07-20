import { prisma } from './db.js'

// Extracted from routes/parseOrder.ts (Phase 4) so the same parsing logic
// can be called directly — not just over HTTP — from the WhatsApp inbound
// webhook (routes/whatsappWebhook.ts, Phase I.2). Keeping one implementation
// means the staff-facing "try a message" endpoint and the real customer
// intake path can never drift out of sync on how order text gets
// interpreted.

const EMPTY_ITEMS_LENGTH = 0

// Arabic-Indic digits (٠-٩) are remapped to ASCII before parsing, so
// `parseFloat` and the amount regex below work identically regardless of
// which script the amount was written in. This only translates the digit
// *script* — it doesn't parse spelled-out numeral words in either language.
const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'
function normalizeDigits(text: string): string {
  return text.replace(/[٠-٩]/gv, (d) => ARABIC_INDIC_DIGITS.indexOf(d).toString())
}

// Named capture groups (required by prefer-named-capture-group) and the 'v'
// flag (required by require-unicode-regexp). Recognizes the English "kg"
// plus the common Arabic weight-unit spellings.
const KG_PATTERN = /(?<amount>[0-9]*\.?[0-9]+)\s*(?:kg|كيلو|كجم|كغم)\s*(?<name>.+)/v

// Splits on English "and"/","/";" and the Arabic comma "،". Deliberately
// does NOT split on a bare Arabic "و" ("and") — in real usage it's almost
// always written attached to the next word with no space, so treating it as
// a delimiter would corrupt words rather than separate order items.
const SEPARATOR_PATTERN = /and|,|;|،/v

export interface ParsedItem {
  product_name: string
  requested_kg: number
  productId: string | null
  pricePerKg: string | null
}

function normalizeForMatch(text: string): string {
  return text.trim().toLowerCase()
}

export interface ParseOrderMessageResult {
  items: ParsedItem[]
  clarificationNeeded: boolean
}

export async function parseOrderMessage(message: string): Promise<ParseOrderMessageResult> {
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
  return {
    items,
    clarificationNeeded: items.length === EMPTY_ITEMS_LENGTH || hasUnmatchedItem
  }
}
