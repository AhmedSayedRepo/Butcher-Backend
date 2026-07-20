// Centralized named HTTP status codes. @typescript-eslint/no-magic-numbers
// (from eslint-config-love) forbids bare numeric literals like
// `.status(400)` scattered across the routes — but this file's whole reason
// to exist is to define those numbers exactly once as named constants, so
// the numeric literals here ARE the source of truth, not scattered magic
// numbers. eslint-config-love's own README explicitly endorses scoped
// eslint-disable comments for exactly this kind of justified exception.
/* eslint-disable @typescript-eslint/no-magic-numbers -- see comment above */
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_SERVER_ERROR: 500
} as const
/* eslint-enable @typescript-eslint/no-magic-numbers */
