// v3.1 follow-up 10g — machine-readable error codes.
//
// Every failure response now carries `code` alongside the existing `error`
// string. The string stays because it's what shows up in logs, in curl output
// and in any non-browser client; the code is what the frontend translates.
//
// Why not translate on the server? Because the server doesn't know who's
// asking. The same 400 can be rendered to an Arabic cashier and an English
// admin, and Accept-Language is a poor proxy for the language toggle the user
// actually picked in the app. Sending a code lets the client render in
// whatever language it's currently showing.
//
// Codes are stable identifiers, so **never renamed once shipped** — a rename
// silently degrades every client that translates the old one. Adding is free.
//
// `params` carries the interpolation values for messages that aren't static
// ("Insufficient stock for Beef · Kandoz. Available: 1.2 kg"), so the
// translated string can put the product name where that language wants it
// rather than the frontend regex-scraping it back out of English prose.

export const ERROR_CODES = {
  // Auth / session
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  CREDENTIALS_REQUIRED: 'CREDENTIALS_REQUIRED',
  ACCOUNT_BANNED: 'ACCOUNT_BANNED',
  TOKEN_INVALID_OR_EXPIRED: 'TOKEN_INVALID_OR_EXPIRED',
  TOO_MANY_LOGIN_ATTEMPTS: 'TOO_MANY_LOGIN_ATTEMPTS',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  ROLE_REQUIRED: 'ROLE_REQUIRED',
  CAP_REQUIRED: 'CAP_REQUIRED',

  // Validation
  VALIDATION_FAILED: 'VALIDATION_FAILED',

  // Not found
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  CUSTOMER_NOT_FOUND: 'CUSTOMER_NOT_FOUND',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND',
  DISMANTLE_EVENT_NOT_FOUND: 'DISMANTLE_EVENT_NOT_FOUND',
  BARCODE_NOT_FOUND: 'BARCODE_NOT_FOUND',

  // Orders
  ORDER_NOT_DRAFT_PROMOTE: 'ORDER_NOT_DRAFT_PROMOTE',
  ORDER_NOT_DRAFT_EDIT: 'ORDER_NOT_DRAFT_EDIT',
  ORDER_NOT_DRAFT_DELETE: 'ORDER_NOT_DRAFT_DELETE',
  ORDER_IS_DRAFT: 'ORDER_IS_DRAFT',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  STATUS_NOT_ALLOWED: 'STATUS_NOT_ALLOWED',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  RECEIPT_SCAN_WRONG_STATUS: 'RECEIPT_SCAN_WRONG_STATUS',
  RECEIPT_CODE_MISMATCH: 'RECEIPT_CODE_MISMATCH',

  // Users / admin
  EMAIL_ALREADY_EXISTS: 'EMAIL_ALREADY_EXISTS',
  LAST_ACTIVE_ADMIN: 'LAST_ACTIVE_ADMIN',
  CANNOT_TARGET_SELF: 'CANNOT_TARGET_SELF',
  USER_HAS_HISTORY: 'USER_HAS_HISTORY',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',

  // Config / server
  ENCRYPTION_KEY_MISSING: 'ENCRYPTION_KEY_MISSING',
  SERVER_ERROR: 'SERVER_ERROR',

  // Dismantle
  DISMANTLE_OUTPUT_AMBIGUOUS: 'DISMANTLE_OUTPUT_AMBIGUOUS',
  DISMANTLE_OUTPUT_FOREIGN: 'DISMANTLE_OUTPUT_FOREIGN',
  DISMANTLE_TEMPLATE_UNKNOWN: 'DISMANTLE_TEMPLATE_UNKNOWN'
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

export interface ApiErrorBody {
  error: string
  code: ErrorCode
  params?: Record<string, string>
  details?: unknown
}

/**
 * Builds the response body. Not a `res.status().json()` wrapper on purpose:
 * the routes already choose their own status from HTTP_STATUS, and hiding that
 * behind a helper would make the status of any given failure harder to find,
 * not easier.
 *
 * `details` carries a Zod flattened error where there is one. It used to be
 * sent as `error` itself, which meant the field was sometimes a string and
 * sometimes an object — every consumer had to type-check it before displaying
 * it, and a client that didn't ended up rendering "[object Object]".
 * `error` is now always a string.
 */
export function apiError(
  code: ErrorCode,
  message: string,
  params?: Record<string, string>,
  details?: unknown
): ApiErrorBody {
  return {
    error: message,
    code,
    ...(params === undefined ? {} : { params }),
    ...(details === undefined ? {} : { details })
  }
}
