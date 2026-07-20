import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/db.js'
import { auth } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import { requireCap } from '../middleware/rbac.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'

const router = Router()

const MIN_NAME_LENGTH = 1
const SEARCH_RESULT_LIMIT = 20
const INITIAL_SPEND = 0

// v3 replan (Phase H — CRM, ADR-012). GET/POST here are deliberately gated
// by plain `auth`, not `requireCap('manage_orders')`: the New Order page
// needs a cashier (role `cashier`, no caps by default — see lib/caps.ts) to
// search for and register customers as part of ordinary order-taking, the
// same tier `POST /api/orders`/`POST /api/orders/draft` already sit at.
// PATCH/DELETE below are the actual "manage customer records" actions and
// stay capability-gated.

router.get('/', auth, asyncHandler(async (req, res) => {
  const { query } = req
  const { q } = query
  const search = typeof q === 'string' ? q.trim() : ''
  const where = search === ''
    ? {}
    : {
        OR: [
          { name: { contains: search, mode: 'insensitive' as const } },
          { phone: { contains: search, mode: 'insensitive' as const } }
        ]
      }
  const customers = await prisma.customer.findMany({
    where,
    orderBy: { name: 'asc' },
    take: SEARCH_RESULT_LIMIT
  })
  res.json(customers)
}))

router.get('/:id', auth, asyncHandler(async (req, res) => {
  const { params } = req
  const { id } = params
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: { orders: { orderBy: { createdAt: 'desc' }, include: { items: true } } }
  })
  if (customer === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Customer not found' })
    return
  }
  const { orders, ...rest } = customer
  const totalSpend = orders.reduce((sum, o) => sum + Number(o.totalAmount), INITIAL_SPEND)
  const [mostRecent] = orders
  res.json({
    ...rest,
    orders,
    totalSpend: totalSpend.toFixed(2),
    lastOrderAt: mostRecent === undefined ? null : mostRecent.createdAt
  })
}))

const CustomerSchema = z.object({
  name: z.string().min(MIN_NAME_LENGTH),
  phone: z.string().min(MIN_NAME_LENGTH).optional(),
  // v3 follow-up: address added alongside notes (notes already existed on
  // the model and API — it just had no create/edit UI until now).
  address: z.string().optional(),
  notes: z.string().optional()
})

router.post('/', auth, asyncHandler<AuthRequest>(async (req, res) => {
  const parsed = CustomerSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: parsed.error.flatten() })
    return
  }
  const { data } = parsed
  const customer = await prisma.customer.create({ data })
  res.status(HTTP_STATUS.CREATED).json(customer)
}))

const UpdateCustomerSchema = CustomerSchema.partial()

// Editing a customer record outside the order-taking flow (correcting a
// name/phone typo, adding notes after the fact) is a step up from just
// looking one up or registering a new one — gated by `manage_orders`
// per ADR-012.
router.patch('/:id', auth, requireCap('manage_orders'), asyncHandler(async (req, res) => {
  const { params } = req
  const { id } = params
  const parsed = UpdateCustomerSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: parsed.error.flatten() })
    return
  }
  const existing = await prisma.customer.findUnique({ where: { id } })
  if (existing === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Customer not found' })
    return
  }
  const { data } = parsed
  const customer = await prisma.customer.update({ where: { id }, data })
  res.json(customer)
}))

const DeleteCustomerSchema = z.object({ confirm: z.literal(true) })

// v3 replan (ADR-013): hard delete, not soft — see the ADR for why this is
// the safer default absent a confirmed jurisdiction. `Order.customerId` is
// set null by the FK's `onDelete: SetNull` (schema.prisma); order/financial
// history is never touched, only de-linked from the removed person.
// Requires `{ confirm: true }` in the body rather than a second round-trip
// confirmation dialog + 409 (like the self-demotion guard in ADR-005) —
// there's no equivalent "would this break something" server-side check to
// make first, so a single explicit confirm flag is enough.
router.delete('/:id', auth, requireCap('manage_orders'), asyncHandler(async (req, res) => {
  const { params } = req
  const { id } = params
  const parsed = DeleteCustomerSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Deleting a customer requires { confirm: true } in the request body' })
    return
  }
  const existing = await prisma.customer.findUnique({ where: { id } })
  if (existing === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Customer not found' })
    return
  }
  await prisma.customer.delete({ where: { id } })
  res.status(HTTP_STATUS.OK).json({ ok: true })
}))

export default router
