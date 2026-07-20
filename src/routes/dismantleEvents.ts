import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/db.js'
import { auth } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import { requireCap } from '../middleware/rbac.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'

const router = Router()

const MIN_LABEL_LENGTH = 1

// Each output either stocks into an existing Product (`productId`) or
// creates a new one (`newProduct`) — see Butcher-Project-Plan-v2.md's Phase
// B.5 workflow section. Both paths go through the same StockAdjustment
// audit trail as a normal inventory edit (Phase B), so there's one history
// per product, not a separate dismantle-only log.
const OutputSchema = z.object({
  cutName: z.string().min(MIN_LABEL_LENGTH),
  actualWeightKg: z.number().positive(),
  isOffal: z.boolean().default(false),
  // v3.1 follow-up 7: non-edible slaughter byproduct (hide/pelt, blood,
  // head/feet) — see the schema comment on DismantleTemplateCut.
  isByproduct: z.boolean().default(false),
  productId: z.string().uuid().optional(),
  newProduct: z.object({
    name: z.string().min(MIN_LABEL_LENGTH),
    unit: z.string().default('kg'),
    pricePerKg: z.number().positive()
  }).optional()
})

const CreateEventSchema = z.object({
  templateId: z.string().uuid(),
  sourceLabel: z.string().min(MIN_LABEL_LENGTH),
  inputWeightKg: z.number().positive(),
  outputs: z.array(OutputSchema).min(MIN_LABEL_LENGTH)
})

// Computed on read, deliberately not stored — see the plan's
// "Auto-calculated fields" section: recorded weights stay the single source
// of truth, so correcting an output later doesn't leave a stale derived
// column anywhere to also fix.
const ZERO = 0

function withComputedFields<T extends {
  inputWeightKg: unknown
  outputs: Array<{ actualWeightKg: unknown }>
}>(event: T): T & { wastePct: number, outputs: Array<T['outputs'][number] & { contentPerKiloKg: number }> } {
  const inputWeightKg = Number(event.inputWeightKg)
  const outputs = event.outputs.map((o) => ({
    ...o,
    contentPerKiloKg: inputWeightKg > ZERO ? Number(o.actualWeightKg) / inputWeightKg : ZERO
  }))
  const totalOutputKg = outputs.reduce((sum, o) => sum + Number(o.actualWeightKg), ZERO)
  const HUNDRED_PERCENT = 100
  const wastePct = inputWeightKg > ZERO ? ((inputWeightKg - totalOutputKg) / inputWeightKg) * HUNDRED_PERCENT : ZERO
  return { ...event, outputs, wastePct }
}

router.get('/', auth, asyncHandler(async (_req, res) => {
  const events = await prisma.dismantleEvent.findMany({
    include: { outputs: true, template: true },
    orderBy: { createdAt: 'desc' }
  })
  res.json(events.map(withComputedFields))
}))

router.get('/:id', auth, asyncHandler(async (req, res) => {
  const { params } = req
  const { id } = params
  const event = await prisma.dismantleEvent.findUnique({
    where: { id },
    include: { outputs: true, template: { include: { cuts: true } } }
  })
  if (event === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Dismantle event not found' })
    return
  }
  res.json(withComputedFields(event))
}))

// v2 replan (Phase B.5): recording a breakdown is gated by the
// `dismantle_carcass` capability (lib/caps.ts) — a manager/admin-only action
// by default, same reasoning as `manage_inventory` on products.ts.
router.post('/', auth, requireCap('dismantle_carcass'), asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' })
    return
  }
  const { user } = req
  const { id: performedBy } = user

  const parsed = CreateEventSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: parsed.error.flatten() })
    return
  }
  const { data } = parsed
  const { templateId, sourceLabel, inputWeightKg, outputs } = data

  const template = await prisma.dismantleTemplate.findUnique({ where: { id: templateId } })
  if (template === null) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Unknown dismantle template' })
    return
  }

  for (const o of outputs) {
    if (o.productId !== undefined && o.newProduct !== undefined) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: `Output "${o.cutName}" specifies both productId and newProduct — pick one`
      })
      return
    }
  }

  const event = await prisma.$transaction(async (tx) => {
    const created = await tx.dismantleEvent.create({
      data: { templateId, sourceLabel, inputWeightKg, performedBy }
    })

    // Deliberately sequential (not Promise.all), unlike the item loops in
    // routes/orders.ts: two outputs from the same event can legitimately
    // target the same existing `productId` (e.g. two cuts both stocked into
    // a shared "trim" product), and the stock update below is a
    // read-then-write (`Number(product.stockKg) + o.actualWeightKg`) — run
    // concurrently, two such outputs could race and one's stock addition
    // would be silently lost.
    /* eslint-disable no-await-in-loop -- see comment above */
    for (const o of outputs) {
      let { productId } = o
      if (o.newProduct !== undefined) {
        const newProduct = await tx.product.create({
          data: {
            name: o.newProduct.name,
            unit: o.newProduct.unit,
            pricePerKg: o.newProduct.pricePerKg,
            stockKg: ZERO
          }
        })
        const { id: newProductId } = newProduct
        productId = newProductId
      }

      await tx.dismantleEventOutput.create({
        data: {
          eventId: created.id,
          cutName: o.cutName,
          actualWeightKg: o.actualWeightKg,
          isOffal: o.isOffal,
          isByproduct: o.isByproduct,
          productId
        }
      })

      if (productId !== undefined) {
        const product = await tx.product.findUniqueOrThrow({ where: { id: productId } })
        await tx.product.update({
          where: { id: productId },
          data: { stockKg: Number(product.stockKg) + o.actualWeightKg }
        })
        await tx.stockAdjustment.create({
          data: {
            productId,
            deltaKg: o.actualWeightKg,
            reason: `Dismantle event ${created.id}: ${o.cutName} (${sourceLabel})`,
            userId: performedBy
          }
        })
      }
    }
    /* eslint-enable no-await-in-loop */

    return await tx.dismantleEvent.findUniqueOrThrow({
      where: { id: created.id },
      include: { outputs: true, template: true }
    })
  })

  res.status(HTTP_STATUS.CREATED).json(withComputedFields(event))
}))

export default router
