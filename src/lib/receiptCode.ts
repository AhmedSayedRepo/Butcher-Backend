import crypto from 'node:crypto'

// v3.1 follow-up 6 (final order state + receipt confirmation). A short code
// printed on the receipt and typed/scanned back in at POST /:id/scan-receipt
// to confirm an ON_THE_WAY order actually got paid for and hand the order
// through to COMPLETED. Deliberately NOT the order's uuid `id` — too long to
// read off a slip of paper or reliably print — and not `dailyNumber` either,
// since that resets to 0 on every closing day and could collide with a
// still-outstanding older order's number. Alphabet excludes visually
// ambiguous characters (0/O, 1/I/L) since this may be read and typed by a
// person, not only scanned.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8

export function generateReceiptCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH)
  let code = ''
  // for...of over a Buffer/Uint8Array yields plain `number`s directly — no
  // index variable and no `?? 0` fallback needed (unlike `bytes[i]`, which
  // TS types as possibly-undefined).
  for (const byte of bytes) {
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length]
  }
  return code
}
