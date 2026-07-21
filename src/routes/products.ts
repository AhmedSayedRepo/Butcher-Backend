import { Router } from 'express'
import type { Product } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/db.js'
import { auth } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import { requireCap } from '../middleware/rbac.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'
import { fireWebhook } from '../lib/webhook.js'
import { isLowStock } from '../lib/lowStock.js'
import { getOrCreateSettings } from '../lib/shopSettings.js'
import { apiError, ERROR_CODES } from '../lib/errorCodes.js'

const router = Router()

// v2 replan (Phase B): optional `category` filter, e.g. GET /api/products?category=Beef
// — additive, GET /api/products with no query still returns everything.
// v3.1 follow-up 10d: was public. The product list carries prices and live
// stock levels — commercially sensitive, and there is no anonymous surface in
// this app that needs it (every page is behind AuthGate).
router.get('/', auth, asyncHandler(async (req, res) => {
  const { query } = req
  const { category } = query
  const where = typeof category === 'string' && category !== '' ? { category } : {}
  const products = await prisma.product.findMany({ where, orderBy: { name: 'asc' } })
  res.json(products)
}))

// v3 replan (Phase I.1 — barcode scanning). Separate small lookup endpoint
// rather than overloading GET / with a barcode filter — this is a fast
// single-item lookup fired on every scan (New Order page's barcode input),
// not a list query. Placed before `/:id/adjustments` purely for readability;
// there's no route-ordering conflict since this path segment (`by-barcode`)
// never collides with a product `:id`.
router.get('/by-barcode/:code', auth, asyncHandler(async (req, res) => {
  const { params } = req
  const { code } = params
  const product = await prisma.product.findUnique({ where: { barcode: code } })
  if (product === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json(apiError(ERROR_CODES.BARCODE_NOT_FOUND, 'No product with that barcode'))
    return
  }
  res.json(product)
}))

const MIN_NAME_LENGTH = 1

const CreateProduct = z.object({
  name: z.string().min(MIN_NAME_LENGTH),
  unit: z.string().default('kg'),
  category: z.string().min(MIN_NAME_LENGTH).optional(),
  pricePerKg: z.number().positive(),
  stockKg: z.number().nonnegative(),
  lowStockAlertKg: z.number().nonnegative().optional(),
  // v3 replan (Phase I.1 — barcode scanning, ADR-008): optional, unique.
  // Lookup-only in this phase — no barcode *generation* feature, since the
  // v3 plan's open question 2 (self-printed vs. supplier-printed) was never
  // answered; lookup-only is the strict subset that's correct either way.
  barcode: z.string().min(MIN_NAME_LENGTH).optional()
})

// v2 replan (Phase B): creating/editing products is exactly what the
// `manage_inventory` capability (see lib/caps.ts, ADR-005) was defined for —
// gating it here is what actually makes that capability mean something,
// rather than existing only in the admin/users screen with nothing checking
// it. The single seeded admin user has every capability by default, so this
// is a no-op for today's only real user; it's cashier/manager accounts
// added later (Phase D's /admin/users screen) that this actually restricts.
router.post('/', auth, requireCap('manage_inventory'), asyncHandler(async (req, res) => {
  const parsed = CreateProduct.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json(apiError(ERROR_CODES.VALIDATION_FAILED, 'Validation failed', undefined, parsed.error.flatten()))
    return
  }

  const { data } = parsed
  const product = await prisma.product.create({ data })
  res.status(HTTP_STATUS.CREATED).json(product)
}))

// Phase 3: inventory create/edit UI needs a way to update price/stock/name
// on an existing product — only GET/POST existed before.
//
// v2 replan (Phase B): `stockKg` can still be edited directly here (e.g. a
// quick correction from the inventory list), but any change to it now
// requires a `reason` and is recorded as a StockAdjustment row — see the
// audit-trail comment below. `category`/`lowStockAlertKg` are plain
// optional fields, no special handling needed.
const UpdateProduct = z.object({
  name: z.string().min(MIN_NAME_LENGTH).optional(),
  unit: z.string().optional(),
  category: z.string().min(MIN_NAME_LENGTH).optional(),
  pricePerKg: z.number().positive().optional(),
  stockKg: z.number().nonnegative().optional(),
  lowStockAlertKg: z.number().nonnegative().optional(),
  barcode: z.string().min(MIN_NAME_LENGTH).optional(),
  reason: z.string().min(MIN_NAME_LENGTH).optional()
})

// Extracted from the PATCH handler below purely to keep its own cyclomatic
// complexity under the lint threshold — same logic, just named and testable
// on its own. Returns an error message if a reason was required but missing.
function reasonRequiredError(stockChanged: boolean, reason: string | undefined): string | null {
  if (stockChanged && reason === undefined) {
    return 'A reason is required when changing stock directly (restock, correction, shrinkage, etc.)'
  }
  return null
}

// Same reasoning as reasonRequiredError above — extracted so the PATCH
// handler's own complexity stays low, not because this needs to be reused.
async function notifyIfNowLowStock(stockChanged: boolean, product: Product): Promise<void> {
  if (!stockChanged) return
  const settings = await getOrCreateSettings()
  const shopDefaultThresholdKg = Number(settings.defaultLowStockThresholdKg)
  if (isLowStock(product, shopDefaultThresholdKg)) {
    void fireWebhook({
      type: 'product.low_stock',
      productId: product.id,
      name: product.name,
      stockKg: product.stockKg.toString(),
      thresholdKg: (product.lowStockAlertKg ?? shopDefaultThresholdKg).toString()
    })
  }
}

router.patch('/:id', auth, requireCap('manage_inventory'), asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json(apiError(ERROR_CODES.UNAUTHORIZED, 'Unauthorized'))
    return
  }
  const { user } = req
  const { id: userId } = user

  const { params } = req
  const { id } = params

  const parsed = UpdateProduct.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json(apiError(ERROR_CODES.VALIDATION_FAILED, 'Validation failed', undefined, parsed.error.flatten()))
    return
  }

  const existing = await prisma.product.findUnique({ where: { id } })
  if (existing === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json(apiError(ERROR_CODES.PRODUCT_NOT_FOUND, 'Product not found'))
    return
  }

  const { data } = parsed
  const { reason, ...fields } = data
  const stockChanged = fields.stockKg !== undefined && fields.stockKg !== Number(existing.stockKg)

  const reasonError = reasonRequiredError(stockChanged, reason)
  if (reasonError !== null) {
    res.status(HTTP_STATUS.BAD_REQUEST).json(apiError(ERROR_CODES.VALIDATION_FAILED, reasonError))
    return
  }

  const product = stockChanged
    ? await prisma.$transaction(async (tx) => {
        const updated = await tx.product.update({ where: { id }, data: fields })
        // fields.stockKg is defined whenever stockChanged is true (that's what
        // the boolean checks above), but TS can't see that correlation through
        // the destructured object — the reason-required check above already
        // guarantees `reason` is a string here too.
        const { stockKg: nextStockKg } = fields
        if (nextStockKg !== undefined && reason !== undefined) {
          await tx.stockAdjustment.create({
            data: {
              productId: id,
              deltaKg: nextStockKg - Number(existing.stockKg),
              reason,
              userId
            }
          })
        }
        return updated
      })
    : await prisma.product.update({ where: { id }, data: fields })

  void notifyIfNowLowStock(stockChanged, product)

  res.json(product)
}))

// v2 replan (Phase B): audit trail for a single product's stock history —
// "why did this change," not just "what is it now."
// v3.1 follow-up 10d: was public — anyone with the URL could read this
// product's entire stock-movement history. Now requires a login.
router.get('/:id/adjustments', auth, asyncHandler(async (req, res) => {
  const { params } = req
  const { id } = params
  const adjustments = await prisma.stockAdjustment.findMany({
    where: { productId: id },
    orderBy: { createdAt: 'desc' }
  })
  res.json(adjustments)
}))

export default router
