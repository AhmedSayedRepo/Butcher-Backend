// Multi-tenancy phase 6 — the cross-tenant leak test
// (Butcher-Multi-Tenancy-Plan.md §4, layer 3).
//
// WHY THIS EXISTS
//
// Layer 1 (the Prisma extension in lib/db.ts) makes tenant scoping automatic.
// Layer 2 (RLS) can't help, because the app connects as the database owner and
// bypasses it. So this is the only thing that actually *proves* isolation
// holds — and, more importantly, keeps proving it after the next twenty
// features are written by someone who has never read this file.
//
// It's written to be adversarial rather than confirmatory. A test that reads
// org A's data as org A tells you nothing; it passes just as happily with the
// filter deleted. Every assertion here asks for **org B's data while in org
// A's context** and requires the answer to be nothing.
//
// RUN:  npx tsx scripts/tenancy-leak-test.ts
//
// Creates two throwaway organizations, exercises them, and deletes both on the
// way out — including after a failure, so a red run doesn't leave debris in a
// production database. It never touches the default organization's rows.

import { PrismaClient } from '@prisma/client'
import { prisma } from '../src/lib/db.js'
import { runInTenantContext } from '../src/lib/tenantContext.js'

const raw = new PrismaClient()

const SUFFIX = Date.now().toString(36)
const ORG_A_SLUG = `leaktest-a-${SUFFIX}`
const ORG_B_SLUG = `leaktest-b-${SUFFIX}`

interface Check { name: string, passed: boolean, detail: string }
const checks: Check[] = []

function record(name: string, passed: boolean, detail = ''): void {
  checks.push({ name, passed, detail })
  const mark = passed ? '  PASS' : '  FAIL'
  // eslint-disable-next-line no-console -- this is a CLI script; console is the output device
  console.log(`${mark}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function asOrg(organizationId: string, fn: () => Promise<void>): Promise<void> {
  return runInTenantContext({ organizationId, isSuperAdmin: false }, fn)
}

async function seedOrganization(slug: string, label: string) {
  const org = await raw.organization.create({
    data: { slug, name: label, email: `${slug}@example.test`, plan: 'trial', billingStatus: 'active' }
  })

  const user = await raw.user.create({
    data: {
      email: `${slug}@example.test`,
      password: 'not-a-real-hash',
      role: 'admin',
      passwordSet: false,
      organizationId: org.id
    }
  })

  const product = await raw.product.create({
    data: {
      name: `${label} beef`,
      unit: 'kg',
      pricePerKg: '10.00',
      stockKg: '100.000',
      // Same barcode in both organizations on purpose: this is the composite
      // unique constraint under test. Before it, the second create here
      // failed outright.
      barcode: `LEAKTEST-${SUFFIX}`,
      organizationId: org.id
    }
  })

  const customer = await raw.customer.create({
    data: { name: `${label} customer`, organizationId: org.id }
  })

  const order = await raw.order.create({
    data: {
      customer: `${label} walk-in`,
      totalAmount: '10.00',
      userId: user.id,
      status: 'CREATED',
      source: 'cashier',
      // Also identical across both, testing the receiptCode composite unique.
      receiptCode: `LEAK${SUFFIX.toUpperCase().slice(0, 4)}`,
      organizationId: org.id
    }
  })

  await raw.cashTransaction.create({
    data: { type: 'IN', category: 'leak-test', amount: '10.00', userId: user.id, organizationId: org.id }
  })

  return { org, user, product, customer, order }
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('\nCross-tenant leak test\n' + '='.repeat(60))

  const a = await seedOrganization(ORG_A_SLUG, 'Org A')
  const b = await seedOrganization(ORG_B_SLUG, 'Org B')
  record('setup: two organizations seeded with identical barcode + receipt code', true,
    'composite unique constraints allow the reuse')

  // ---------------------------------------------------------------------
  // Reads: in A's context, B's rows must be invisible — by id, in lists,
  // and in aggregates.
  // ---------------------------------------------------------------------
  await asOrg(a.org.id, async () => {
    record('findUnique on B\'s order returns null',
      await prisma.order.findUnique({ where: { id: b.order.id } }) === null)

    record('findFirst on B\'s product returns null',
      await prisma.product.findFirst({ where: { id: b.product.id } }) === null)

    record('findUnique on B\'s customer returns null',
      await prisma.customer.findUnique({ where: { id: b.customer.id } }) === null)

    record('findUnique on B\'s user returns null',
      await prisma.user.findUnique({ where: { id: b.user.id } }) === null)

    const orders = await prisma.order.findMany()
    record('findMany returns no order belonging to B',
      !orders.some(o => o.organizationId === b.org.id), `${orders.length} orders visible`)

    const products = await prisma.product.findMany()
    record('findMany returns no product belonging to B',
      !products.some(p => p.organizationId === b.org.id), `${products.length} products visible`)

    // Aggregates are the leak people forget: a total that silently spans every
    // shop is wrong in a way nobody notices until the numbers are audited.
    const cashCount = await prisma.cashTransaction.count()
    const ownCash = await raw.cashTransaction.count({ where: { organizationId: a.org.id } })
    record('count() is scoped to A', cashCount === ownCash, `${cashCount} vs ${ownCash} own`)

    const sum = await prisma.cashTransaction.aggregate({ _sum: { amount: true } })
    const ownSum = await raw.cashTransaction.aggregate({
      _sum: { amount: true }, where: { organizationId: a.org.id }
    })
    record('aggregate() is scoped to A',
      String(sum._sum.amount) === String(ownSum._sum.amount),
      `${String(sum._sum.amount)} vs ${String(ownSum._sum.amount)}`)

    // Barcode lookup: both organizations use the SAME barcode, so an unscoped
    // lookup would return whichever row the database happened to reach first.
    const scanned = await prisma.product.findFirst({ where: { barcode: `LEAKTEST-${SUFFIX}` } })
    record('barcode lookup returns A\'s product, not B\'s',
      scanned !== null && scanned.id === a.product.id)
  })

  // ---------------------------------------------------------------------
  // Writes: A must not be able to change or delete B's rows. `updateMany`
  // and `deleteMany` are the dangerous shapes — they don't error on a miss,
  // they report a count, and an unscoped one would quietly rewrite B's data.
  // ---------------------------------------------------------------------
  await asOrg(a.org.id, async () => {
    const updated = await prisma.order.updateMany({
      where: { id: b.order.id }, data: { customer: 'HIJACKED' }
    })
    record('updateMany cannot touch B\'s order', updated.count === 0, `${updated.count} rows`)

    const deleted = await prisma.cashTransaction.deleteMany({ where: { organizationId: b.org.id } })
    record('deleteMany cannot touch B\'s cash ledger', deleted.count === 0, `${deleted.count} rows`)

    const blindUpdate = await prisma.product.updateMany({ data: { pricePerKg: '99.99' } })
    const bProduct = await raw.product.findUnique({ where: { id: b.product.id } })
    record('unfiltered updateMany still only hits A',
      String(bProduct?.pricePerKg) === '10',
      `${blindUpdate.count} rows changed, B's price ${String(bProduct?.pricePerKg)}`)
  })

  // ---------------------------------------------------------------------
  // Creates are stamped with the context's organization, without being told.
  // ---------------------------------------------------------------------
  await asOrg(a.org.id, async () => {
    const created = await prisma.customer.create({ data: { name: 'auto-stamped' } })
    record('create() stamps organizationId from context',
      created.organizationId === a.org.id)
    await raw.customer.delete({ where: { id: created.id } })
  })

  // ---------------------------------------------------------------------
  // And the control: without a context, nothing is filtered. This asserts the
  // test itself is capable of detecting a leak — if this one "passes" as
  // isolated too, every assertion above is meaningless.
  // ---------------------------------------------------------------------
  const unscopedOrder = await prisma.order.findUnique({ where: { id: b.order.id } })
  record('CONTROL: with no tenant context, B\'s order IS visible',
    unscopedOrder !== null,
    'proves the checks above are actually testing something')
}

async function cleanup(): Promise<void> {
  // Ordered by foreign key: children first. `deleteMany` on the raw client so
  // cleanup can't itself be filtered out.
  for (const slug of [ORG_A_SLUG, ORG_B_SLUG]) {
    const org = await raw.organization.findUnique({ where: { slug }, select: { id: true } })
    if (org === null) continue
    const where = { organizationId: org.id }
    await raw.cashTransaction.deleteMany({ where })
    await raw.orderStatusEvent.deleteMany({ where })
    await raw.orderItem.deleteMany({ where })
    await raw.order.deleteMany({ where })
    await raw.stockAdjustment.deleteMany({ where })
    await raw.product.deleteMany({ where })
    await raw.customer.deleteMany({ where })
    await raw.passwordResetToken.deleteMany({ where })
    await raw.shopSettings.deleteMany({ where })
    await raw.idempotencyKey.deleteMany({ where })
    await raw.user.deleteMany({ where })
    await raw.organization.delete({ where: { id: org.id } })
  }
}

main()
  .catch((err: unknown) => {
    record('unexpected error', false, err instanceof Error ? err.message : String(err))
  })
  .finally(async () => {
    // Cleanup runs even on failure: a red test must not leave two half-built
    // organizations in a production database.
    await cleanup().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('CLEANUP FAILED — remove these by hand:', ORG_A_SLUG, ORG_B_SLUG, err)
    })
    await raw.$disconnect()
    await prisma.$disconnect()

    const failed = checks.filter(c => !c.passed)
    // eslint-disable-next-line no-console
    console.log('='.repeat(60))
    // eslint-disable-next-line no-console
    console.log(`${checks.length - failed.length}/${checks.length} passed`)
    if (failed.length > 0) {
      // eslint-disable-next-line no-console
      console.error('\nFAILED:\n' + failed.map(f => `  - ${f.name}`).join('\n'))
      process.exitCode = 1
    }
  })
