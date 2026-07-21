// Multi-tenancy phase 2 — the ambient "which organization is this request
// for?" (Butcher-Multi-Tenancy-Plan.md §4, layer 1).
//
// The alternative was threading an `organizationId` argument through every
// route handler and every helper they call. That works right up until the
// first person forgets one, and a forgotten argument in this codebase means a
// query that returns another shop's data. AsyncLocalStorage lets the Prisma
// extension read the current tenant without anyone passing it anywhere, so
// "remembering" stops being part of the job.
//
// AsyncLocalStorage survives `await` boundaries: everything downstream of
// `runInTenantContext` — including promise callbacks and transaction bodies —
// sees the same store. Node has had it stable since v16.
import { AsyncLocalStorage } from 'node:async_hooks'

export interface TenantContext {
  /**
   * The organization this request may touch. `null` means "no tenant" — which
   * is a real, legitimate state for exactly two kinds of request:
   *
   *   1. Unauthenticated ones (login, password reset), which run before we
   *      know who's asking.
   *   2. A super admin managing organizations, who belongs to none of them.
   *
   * The Prisma extension treats `null` as "do not filter", so anything running
   * outside a tenant context sees everything. That's why §4 layer 3 (the leak
   * test) exists — this design is safe only as long as authenticated routes
   * genuinely run inside a context, and only a test that tries to break it can
   * keep proving that.
   */
  organizationId: string | null
  /** Super admins deliberately bypass the filter. See `requireSuperAdmin`. */
  isSuperAdmin: boolean
}

const storage = new AsyncLocalStorage<TenantContext>()

export function runInTenantContext<T>(context: TenantContext, fn: () => T): T {
  return storage.run(context, fn)
}

export function getTenantContext(): TenantContext | undefined {
  return storage.getStore()
}

/**
 * The id the Prisma extension should filter by, or `null` for no filtering.
 *
 * Returns `null` for a super admin *by design*: managing organizations means
 * reading across all of them. That is the one deliberate hole in layer 1, it's
 * narrow, and it's gated by `requireSuperAdmin` on the routes that use it.
 */
export function currentOrganizationId(): string | null {
  const context = storage.getStore()
  if (context === undefined || context.isSuperAdmin) return null
  return context.organizationId
}
