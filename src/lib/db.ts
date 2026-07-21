import { PrismaClient } from '@prisma/client'
import { currentOrganizationId } from './tenantContext.js'

// ============================================================================
// Multi-tenancy phase 2 — automatic tenant scoping
// (Butcher-Multi-Tenancy-Plan.md §4, layer 1).
//
// There are ~75 `prisma.*` calls across the routes. Adding
// `where: { organizationId }` to each by hand is a job that gets done
// correctly once and then eroded by the next twenty features — and the failure
// mode is silent. A missing filter doesn't throw; it returns another shop's
// orders, and looks exactly like a working query.
//
// So the filter is injected here instead. A developer who forgets it gets it
// anyway, and the only way to opt out is to say so explicitly.
//
// WHAT THIS IS NOT: a defence against a hostile database client. Prisma
// connects as the database owner, which bypasses Postgres RLS entirely, so RLS
// cannot backstop a bug in this file. That's why the plan calls this layer 1
// and the leak test layer 3 — the test is what keeps proving this works.
// ============================================================================

// Models carrying an `organizationId`. Everything else is either global
// reference data (DismantleTemplate/DismantleTemplateCut — the same carcass
// breakdowns for every shop) or the tenant table itself.
const TENANT_MODELS = new Set([
  'User',
  'PasswordResetToken',
  'Customer',
  'CashTransaction',
  'ShopSettings',
  'IdempotencyKey',
  'Product',
  'Order',
  'OrderStatusEvent',
  'OrderItem',
  'StockAdjustment',
  'DismantleEvent',
  'DailyClosing',
  'DismantleEventOutput'
])

// Operations whose `where` decides which rows are affected. `count`,
// `aggregate` and `groupBy` are in here because a total that silently spans
// every shop is its own kind of leak — a revenue figure that's wrong is worse
// than one that's missing.
const WHERE_OPERATIONS = new Set([
  'findFirst', 'findFirstOrThrow', 'findMany', 'findUnique', 'findUniqueOrThrow',
  'update', 'updateMany', 'delete', 'deleteMany', 'count', 'aggregate', 'groupBy'
])

const CREATE_OPERATIONS = new Set(['create', 'createMany'])

// `findUnique` can't be scoped in place: Prisma only accepts unique fields in
// its `where`, and `organizationId` isn't one.
//
// The first version of this swapped the call for `findFirst`. That worked but
// needed an `any` cast to reach the model off the base client — an escape
// hatch in the one file whose whole job is to be trustworthy. This checks the
// *result* instead: run the lookup as written, then discard the row if it
// belongs to another organization. Same outcome (a cross-tenant id is "not
// found", so a 404 rather than a leak), same single query, no casts.
const UNIQUE_OPERATIONS = new Set(['findUnique', 'findUniqueOrThrow'])

interface QueryArgs {
  where?: Record<string, unknown>
  data?: Record<string, unknown> | Array<Record<string, unknown>>
  create?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * True when a returned row demonstrably belongs to a different organization.
 *
 * Anything without an `organizationId` — a `select` that didn't ask for it, an
 * aggregate shape, null — is treated as "can't tell" and left alone. That is
 * the safe direction here: those calls have already been filtered by `where`,
 * and this check exists only for the `findUnique` path that couldn't be.
 */
function belongsToAnotherOrganization(result: unknown, organizationId: string): boolean {
  if (typeof result !== 'object' || result === null) return false
  if (!('organizationId' in result)) return false
  // `in` narrows `result` to something with the property, so this needs no
  // cast — which matters in a file where a stray `as any` would undermine the
  // whole point.
  const owner: unknown = result.organizationId
  return typeof owner === 'string' && owner !== organizationId
}

function withOrganization(row: Record<string, unknown>, organizationId: string): Record<string, unknown> {
  // Never overwrite an explicit value. A route that deliberately writes into
  // another organization — creating one and seeding its first admin — has
  // already said what it means, and silently rewriting that would be worse
  // than not filtering at all.
  return 'organizationId' in row || 'organization' in row
    ? row
    : { ...row, organizationId }
}

function isQueryArgs(value: unknown): value is QueryArgs {
  return typeof value === 'object' && value !== null
}

function scopedArgs(operation: string, args: QueryArgs, organizationId: string): QueryArgs {
  if (WHERE_OPERATIONS.has(operation)) {
    return { ...args, where: { ...args.where, organizationId } }
  }

  if (CREATE_OPERATIONS.has(operation)) {
    const { data } = args
    if (Array.isArray(data)) {
      return { ...args, data: data.map(row => withOrganization(row, organizationId)) }
    }
    if (data !== undefined) {
      return { ...args, data: withOrganization(data, organizationId) }
    }
    return args
  }

  if (operation === 'upsert') {
    // Both halves: the lookup must be scoped and the row it may create stamped.
    const create = args.create === undefined ? undefined : withOrganization(args.create, organizationId)
    return {
      ...args,
      where: { ...args.where, organizationId },
      ...(create === undefined ? {} : { create })
    }
  }

  return args
}

// Prisma declares this callback's parameter as `any`, so a narrower concrete
// type is accepted here — and taking one means there is no `any` anywhere in
// this file, and therefore no blanket eslint-disable to hide behind. In the
// one module whose entire job is to be trustworthy, that's worth the extra
// twelve lines.
interface AllOperationsArgs {
  /** PascalCase model name. Absent for raw queries, which aren't scoped. */
  model?: string
  operation: string
  args: unknown
  query: (args: unknown) => Promise<unknown>
}

export const prisma = new PrismaClient().$extends({
  name: 'tenantScope',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }: AllOperationsArgs): Promise<unknown> {
        const organizationId = currentOrganizationId()

        // No tenant in context: unauthenticated routes, super-admin routes,
        // seeding, scripts. Deliberately unfiltered — see TenantContext.
        if (organizationId === null || model === undefined || !TENANT_MODELS.has(model)) {
          return await query(args)
        }

        if (UNIQUE_OPERATIONS.has(operation)) {
          const result = await query(args)
          if (!belongsToAnotherOrganization(result, organizationId)) return result
          // Same shape the caller already handles for a genuine miss.
          if (operation === 'findUnique') return null
          throw new Error(`No ${model} found`)
        }

        return await query(scopedArgs(operation, isQueryArgs(args) ? args : {}, organizationId))
      }
    }
  }
})

/**
 * The un-extended client, for the few places that legitimately must cross
 * tenants: resolving which organization a login belongs to (before any tenant
 * is known), and super-admin organization management.
 *
 * Deliberately awkward to type and easy to grep for. Every use is a place the
 * automatic filter is switched off, so every use should say why in a comment.
 */
export const prismaUnscoped = new PrismaClient()

/**
 * The transaction client *as seen inside `prisma.$transaction`*.
 *
 * Not `Prisma.TransactionClient` — that's the un-extended shape, and once the
 * client carries an extension the two are structurally different types.
 * Helpers that take a `tx` have to use this one or they can't be called with
 * the client the routes actually have.
 *
 * Derived from the client rather than hand-written so it can't drift: change
 * the extension and this follows.
 */
export type TransactionClient = Omit<
  typeof prisma,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>
