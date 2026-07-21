import { Router } from 'express'
import { z } from 'zod'
import { OrderStatus } from '@prisma/client'
import { prisma } from '../lib/db.js'
import { auth } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import { requireCap } from '../middleware/rbac.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'
import { fireWebhook } from '../lib/webhook.js'
import { itemsSummary } from '../lib/orderItemsSummary.js'
import { apiError, ERROR_CODES } from '../lib/errorCodes.js'

// v3.1 follow-up 6: split out of routes/orders.ts (which was over the
// max-lines limit) — mounted on the same '/api/orders' prefix as that
// router in index.ts, since Express supports multiple routers sharing one
// path prefix. Purely a file split, no behavior change.
const router = Router()

const MIN_RECEIPT_CODE_LENGTH = 1

const ScanReceiptSchema = z.object({
  code: z.string().min(MIN_RECEIPT_CODE_LENGTH)
})

// The only path from ON_THE_WAY to COMPLETED — see the PATCH /:id/status
// guard in orders.ts and the OrderStatus schema comment for why this is
// deliberately not a plain status PATCH. Matches the submitted code against
// this specific order's stored `receiptCode` (case/whitespace insensitive,
// since it may be hand-typed as a scanner fallback — see lib/receiptCode.ts)
// rather than looking the order up by code alone, so scanning the wrong
// receipt against an already-open order detail view fails clearly instead
// of silently completing a different order.
router.post('/:id/scan-receipt', auth, requireCap('manage_orders'), asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json(apiError(ERROR_CODES.UNAUTHORIZED, 'Unauthorized'))
    return
  }
  const { user, params } = req
  const { id } = params

  const parsed = ScanReceiptSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json(apiError(ERROR_CODES.VALIDATION_FAILED, 'Validation failed', undefined, parsed.error.flatten()))
    return
  }
  const { data } = parsed
  const { code } = data

  const existing = await prisma.order.findUnique({
    where: { id },
    include: { items: { include: { product: true } } }
  })
  if (existing === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json(apiError(ERROR_CODES.ORDER_NOT_FOUND, 'Order not found'))
    return
  }
  if (existing.status !== OrderStatus.ON_THE_WAY) {
    res.status(HTTP_STATUS.BAD_REQUEST).json(apiError(ERROR_CODES.RECEIPT_SCAN_WRONG_STATUS, 'Only on-the-way orders can be confirmed by scanning the receipt'))
    return
  }
  if (existing.receiptCode?.toUpperCase() !== code.trim().toUpperCase()) {
    res.status(HTTP_STATUS.BAD_REQUEST).json(apiError(ERROR_CODES.RECEIPT_CODE_MISMATCH, 'Receipt code does not match this order'))
    return
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id }, data: { status: OrderStatus.COMPLETED } })
    await tx.orderStatusEvent.create({
      data: { orderId: id, status: OrderStatus.COMPLETED, changedBy: user.id }
    })
  })

  const items = existing.items.map((it) => ({ itemName: it.product.name, kg: it.kg.toString() }))
  void fireWebhook({
    type: 'order.status_changed',
    orderId: id,
    orderNumber: existing.dailyNumber,
    customer: existing.customer,
    totalAmount: existing.totalAmount.toString(),
    items,
    itemsSummary: itemsSummary(items),
    status: OrderStatus.COMPLETED,
    previousStatus: OrderStatus.ON_THE_WAY
  })

  const full = await prisma.order.findUnique({ where: { id }, include: { items: { include: { product: true } } } })
  res.json(full)
}))

export default router
