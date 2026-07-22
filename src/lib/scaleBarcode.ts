// v3.3 — parsing the barcodes a weighing scale prints.
//
// A retail scale doesn't print the product's own barcode. It prints a
// "variable-measure" label whose digits encode the item AND either its weight
// or its price — a different string on every label, because the weight differs
// every time. So the plain by-barcode lookup can never match one: the whole
// point here is to pull the item code and the measured value back OUT of the
// digits.
//
// There is no single universal layout — each scale is configured with its own
// prefix, field positions and units — so nothing here is hard-coded. The whole
// scheme is data (`ScaleBarcodeConfig`, stored per shop in ShopSettings) and
// this file is the one interpreter of it. That's what lets one parser fit any
// scale: describe the label, don't code it.
//
// Positions are 1-based digit indices, because that's how a person reads them
// off a printed barcode ("the weight starts at the 8th digit"). Converted to
// 0-based slicing internally.

import { z } from 'zod'

const DIGITS_ONLY = /^\d+$/v
const ZERO = 0
const PAIR = 2
const MIN_POSITION = 1
const MIN_TOTAL_LEN = 6
const MAX_TOTAL_LEN = 20
const MIN_DIVISOR = 1
const EAN13_LENGTH = 13
const CHECK_MULTIPLIER_ODD = 1
const CHECK_MULTIPLIER_EVEN = 3
const CHECK_MOD = 10
const DECIMAL_RADIX = 10

export const ScaleBarcodeConfigSchema = z.object({
  enabled: z.boolean(),
  // Leading digit(s) that mark a label as a scale label rather than an
  // ordinary product barcode. GS1 reserves the 2x range for in-store
  // variable-measure items, so this is typically "2", but it's free text so a
  // shop whose scale uses something else isn't stuck.
  prefix: z.string().regex(DIGITS_ONLY, 'Prefix must be digits'),
  // The full length of a scale label (e.g. 13 for EAN-13). A scan only counts
  // as a scale label when its length matches AND it starts with the prefix —
  // together those keep an ordinary barcode from being misread as a label.
  totalLength: z.number().int().min(MIN_TOTAL_LEN).max(MAX_TOTAL_LEN),
  itemStart: z.number().int().min(MIN_POSITION),
  itemLength: z.number().int().min(MIN_POSITION),
  valueStart: z.number().int().min(MIN_POSITION),
  valueLength: z.number().int().min(MIN_POSITION),
  // What the value digits mean. 'weight' → the app prices it from the
  // product's own price-per-kg. 'price' → the digits ARE the line total and
  // the scale is the pricing authority.
  valueType: z.enum(['weight', 'price']),
  // The value digits are an integer; divide by this to get the real number.
  // Weight in grams → 1000 (12340 → 12.340 kg). Price in minor units → 100
  // (04599 → 45.99). A scale that prints kg to 3 decimals as an integer is
  // also just 1000.
  valueDivisor: z.number().int().min(MIN_DIVISOR),
  // EAN-13 carries a mod-10 check digit; validating it rejects a misread
  // before it becomes a wrong weight on an order. Off by default because it
  // only applies to genuine 13-digit EAN labels.
  validateCheckDigit: z.boolean()
})

export type ScaleBarcodeConfig = z.infer<typeof ScaleBarcodeConfigSchema>

export interface ScaleParseResult {
  itemCode: string
  value: number
  valueType: 'weight' | 'price'
}

// EAN-13 mod-10: sum digits with alternating 1/3 weights (from the left, the
// first data digit is weight 1), and the check digit is what makes the total a
// multiple of 10.
function ean13CheckDigitValid(code: string): boolean {
  if (code.length !== EAN13_LENGTH) return false
  const body = code.slice(ZERO, EAN13_LENGTH - MIN_POSITION)
  // Array.from, not [...body]: the code is pure ASCII digits, but the
  // spread-on-string lint rule (rightly, in general) flags `...` for
  // code-point decomposition. Array.from sidesteps it and reads the same.
  let sum = ZERO
  for (const [index, char] of Array.from(body).entries()) {
    const weight = index % PAIR === ZERO ? CHECK_MULTIPLIER_ODD : CHECK_MULTIPLIER_EVEN
    sum += Number(char) * weight
  }
  const check = (CHECK_MOD - (sum % CHECK_MOD)) % CHECK_MOD
  return check === Number(code[EAN13_LENGTH - MIN_POSITION])
}

// Reads the digits at a 1-based [start, start+length) window. Returns null if
// the window falls outside the string — a misconfiguration that must fail
// loudly rather than silently read a shorter code.
function windowAt(code: string, start: number, length: number): string | null {
  const from = start - MIN_POSITION
  const to = from + length
  if (from < ZERO || to > code.length) return null
  return code.slice(from, to)
}

/**
 * Parses a raw scanned string against a scale scheme.
 *
 * Returns null when the string is not a scale label for this scheme (wrong
 * length or prefix) OR when it looks like one but is malformed (non-numeric,
 * field out of range, bad check digit). The caller treats null as "not a scale
 * label" and falls back to a plain barcode lookup — a genuine misread simply
 * won't match a product either way, which is the safe outcome.
 */
export function parseScaleBarcode(code: string, config: ScaleBarcodeConfig): ScaleParseResult | null {
  if (!config.enabled) return null
  const trimmed = code.trim()
  if (!DIGITS_ONLY.test(trimmed)) return null
  if (trimmed.length !== config.totalLength) return null
  if (!trimmed.startsWith(config.prefix)) return null
  if (config.validateCheckDigit && !ean13CheckDigitValid(trimmed)) return null

  const itemDigits = windowAt(trimmed, config.itemStart, config.itemLength)
  const valueDigits = windowAt(trimmed, config.valueStart, config.valueLength)
  if (itemDigits === null || valueDigits === null) return null

  const rawValue = Number.parseInt(valueDigits, DECIMAL_RADIX)
  if (!Number.isFinite(rawValue)) return null

  return {
    itemCode: itemDigits,
    value: rawValue / config.valueDivisor,
    valueType: config.valueType
  }
}
