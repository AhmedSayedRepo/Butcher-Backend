import type { Prisma } from '@prisma/client'
import { prisma } from './db.js'

// v3 replan — real gap identified in Butcher-Project-Plan-v3.md's
// best-practices section: nothing in this app (existing POST /api/orders
// included) previously protected against a duplicate submission from a
// double-click or a retried network request. Callers pass the client-
// supplied `Idempotency-Key` header (if present) plus a fixed endpoint name;
// a repeat request with the same key+endpoint pair gets the stored response
// replayed instead of the handler re-running (and re-decrementing stock, or
// re-inserting a cash transaction). Frontend sends `crypto.randomUUID()`
// once per submit *attempt* — same UUID across retries of that one attempt,
// a fresh one for a genuinely new click — see the New Order / cash-entry
// forms' submit handlers.
//
// The header is optional: a caller (curl, an older client) that never sends
// one simply gets no idempotency protection, same as before this existed —
// this is additive safety, not a new required contract.

export async function findIdempotentResponse(endpoint: string, key: string | undefined): Promise<unknown> {
  if (key === undefined || key === '') return undefined
  // findFirst for the same reason as the barcode lookup: the unique key is
  // now (organizationId, key, endpoint), and the organization half is supplied
  // by the tenant context, not by this caller.
  const existing = await prisma.idempotencyKey.findFirst({
    where: { key, endpoint }
  })
  return existing === null ? undefined : existing.responseBody
}

export async function storeIdempotentResponse(endpoint: string, key: string | undefined, responseBody: Prisma.InputJsonValue): Promise<void> {
  if (key === undefined || key === '') return
  await prisma.idempotencyKey.create({
    data: { key, endpoint, responseBody }
  })
}

// Every call site needs to strip a Prisma result (Decimal/Date fields) down
// to plain JSON before it's storable as `Prisma.InputJsonValue` — the
// round-trip through `JSON.parse(JSON.stringify(...))` is the simplest way,
// but `JSON.parse` itself returns `any`, which would otherwise flow an
// unsafe argument into every caller of `storeIdempotentResponse`. Centralizing
// the round-trip (and its one necessary cast) here means every call site
// passes a properly-typed value instead of repeating an unsafe `any` at each
// of them.
export function toIdempotentJson(value: unknown): Prisma.InputJsonValue {
  const roundTripped: unknown = JSON.parse(JSON.stringify(value))
  // Genuinely unavoidable here, not a lazy cast: `JSON.parse`'s result has
  // no static type more precise than `unknown`/`any` — there's no runtime
  // shape TypeScript can verify a round-tripped Prisma result against ahead
  // of time, short of writing a full recursive JSON-value type guard for a
  // one-line helper. Scoped to this single return, same precedent as
  // lib/whatsapp.ts's Meta-payload casts.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse has no more precise static type; see comment above
  return roundTripped as Prisma.InputJsonValue
}

// Reads the standard `Idempotency-Key` header — pulled into a helper so
// every route that supports it extracts it the same (case-insensitive,
// Express lower-cases header names already) way.
export function idempotencyKeyFrom(headers: Record<string, string | string[] | undefined>): string | undefined {
  const { 'idempotency-key': raw } = headers
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}
