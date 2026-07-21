// v3.2 — matching an inbound WhatsApp number to an existing customer.
//
// The two numbers are almost never written the same way. WhatsApp delivers
// E.164 without a plus (`201018185200`); a shop types what the customer told
// them (`01018185200`, `0101 818 5200`, `+20 101 818 5200`). A string
// comparison finds none of those.
//
// So: strip everything that isn't a digit, then compare the last N digits.
// That survives country-code prefixes, the leading zero Egyptian numbers are
// written with, spaces, dashes and brackets, all at once.

const SIGNIFICANT_DIGITS = 9
const NOT_DIGITS = /\D/gv

export function digitsOnly(value: string): string {
  return value.replace(NOT_DIGITS, '')
}

/**
 * The comparable tail of a phone number, or null if there aren't enough digits
 * to be worth comparing.
 *
 * Nine digits, chosen deliberately:
 *   - Egyptian mobiles are 10 digits nationally (01X XXXX XXX) and 12 in E.164
 *     (20 1X XXXX XXX). Taking nine ignores both the country code and the
 *     national leading zero, which is exactly the difference that breaks a
 *     naive comparison.
 *   - Short enough to survive formatting differences, long enough that a
 *     collision within one shop's customer list is implausible.
 *
 * The caveat, stated rather than hidden: nine digits could theoretically match
 * two customers in *different* countries. A single butcher shop's customers
 * are overwhelmingly in one country, and the consequence of a false match is a
 * draft attached to the wrong name — visible on screen, fixable in one click,
 * before the order is ever confirmed. That's an acceptable trade for a match
 * that works on real, messily-typed data. It would not be if this auto-charged
 * anyone.
 */
export function phoneKey(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const digits = digitsOnly(value)
  if (digits.length < SIGNIFICANT_DIGITS) return null
  return digits.slice(-SIGNIFICANT_DIGITS)
}

/** True when two differently-formatted numbers are the same line. */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const keyA = phoneKey(a)
  const keyB = phoneKey(b)
  return keyA !== null && keyA === keyB
}
