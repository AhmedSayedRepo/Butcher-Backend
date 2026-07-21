import { Router } from 'express'
import { z } from 'zod'
import type { DismantleEventOutput } from '@prisma/client'
import { prisma } from '../lib/db.js'
import type { TransactionClient } from '../lib/db.js'
import { auth } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import { requireCap } from '../middleware/rbac.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'
import { apiError, ERROR_CODES } from '../lib/errorCodes.js'

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

// v3.1 follow-up 13: edit/delete for dismantle events. Deliberately narrower
// than create — an edit can change an existing output's weight/cutName/
// flags, but can't add/remove outputs or move one to a different product.
// Reassigning which Product an output stocks into would mean unwinding one
// product's stock and applying another's, which needs its own careful
// review; not needed for the "fix a typo'd weight" use case this is for.
const UpdateOutputSchema = z.object({
  id: z.string().uuid(),
  cutName: z.string().min(MIN_LABEL_LENGTH).optional(),
  actualWeightKg: z.number().positive().optional(),
  isOffal: z.boolean().optional(),
  isByproduct: z.boolean().optional()
})

const UpdateEventSchema = z.object({
  sourceLabel: z.string().min(MIN_LABEL_LENGTH).optional(),
  inputWeightKg: z.number().positive().optional(),
  outputs: z.array(UpdateOutputSchema).optional()
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
    res.status(HTTP_STATUS.NOT_FOUND).json(apiError(ERROR_CODES.DISMANTLE_EVENT_NOT_FOUND, 'Dismantle event not found'))
    return
  }
  res.json(withComputedFields(event))
}))

// v2 replan (Phase B.5): recording a breakdown is gated by the
// `dismantle_carcass` capability (lib/caps.ts) — a manager/admin-only action
// by default, same reasoning as `manage_inventory` on products.ts.
router.post('/', auth, requireCap('dismantle_carcass'), asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json(apiError(ERROR_CODES.UNAUTHORIZED, 'Unauthorized'))
    return
  }
  const { user } = req
  const { id: performedBy } = user

  const parsed = CreateEventSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json(apiError(ERROR_CODES.VALIDATION_FAILED, 'Validation failed', undefined, parsed.error.flatten()))
    return
  }
  const { data } = parsed
  const { templateId, sourceLabel, inputWeightKg, outputs } = data

  const template = await prisma.dismantleTemplate.findUnique({ where: { id: templateId } })
  if (template === null) {
    res.status(HTTP_STATUS.BAD_REQUEST).json(apiError(ERROR_CODES.DISMANTLE_TEMPLATE_UNKNOWN, 'Unknown dismantle template'))
    return
  }

  for (const o of outputs) {
    if (o.productId !== undefined && o.newProduct !== undefined) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        ...apiError(ERROR_CODES.DISMANTLE_OUTPUT_AMBIGUOUS, `Output "${o.cutName}" specifies both productId and newProduct — pick one`, { name: o.cutName })
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

// v3.1 follow-up 13 lint fix: pulled out of the PATCH transaction below —
// that arrow function's complexity (nested weight-changed / productId /
// unchanged-value branches inline) tripped eslint-config-love's `complexity`
// rule (18 > the max of 10). Same behavior, just named and testable on its
// own: update the one output row, then reconcile its product's stock only
// if the weight actually changed and it's stocked into a product.
// `eventId`/`actorUserId` are bundled into one `ctx` object rather than two
// more positional params — @typescript-eslint/max-params caps this at 4.
interface ApplyOutputUpdateContext {
  eventId: string
  actorUserId: string
}

async function applyOutputUpdate(
  tx: TransactionClient,
  before: DismantleEventOutput,
  u: z.infer<typeof UpdateOutputSchema>,
  ctx: ApplyOutputUpdateContext
): Promise<void> {
  const { eventId, actorUserId } = ctx

  await tx.dismantleEventOutput.update({
    where: { id: u.id },
    data: {
      ...(u.cutName !== undefined && { cutName: u.cutName }),
      ...(u.actualWeightKg !== undefined && { actualWeightKg: u.actualWeightKg }),
      ...(u.isOffal !== undefined && { isOffal: u.isOffal }),
      ...(u.isByproduct !== undefined && { isByproduct: u.isByproduct })
    }
  })

  if (u.actualWeightKg === undefined || before.productId === null) return
  if (u.actualWeightKg === Number(before.actualWeightKg)) return

  const { productId } = before
  const deltaKg = u.actualWeightKg - Number(before.actualWeightKg)
  await tx.product.update({
    where: { id: productId },
    data: { stockKg: { increment: deltaKg } }
  })
  await tx.stockAdjustment.create({
    data: {
      productId,
      deltaKg,
      reason: `Dismantle event ${eventId} edited: ${u.cutName ?? before.cutName} weight ${Number(before.actualWeightKg).toString()} → ${u.actualWeightKg.toString()} kg`,
      userId: actorUserId
    }
  })
}

// v3.1 follow-up 13: same cap as recording one in the first place — a
// manager/admin who's trusted to log a breakdown is trusted to correct it.
router.patch('/:id', auth, requireCap('dismantle_carcass'), asyncHandler<AuthRequest>(async (req, res) => {
  const { params } = req
  const { id } = params

  const existing = await prisma.dismantleEvent.findUnique({ where: { id }, include: { outputs: true } })
  if (existing === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json(apiError(ERROR_CODES.DISMANTLE_EVENT_NOT_FOUND, 'Dismantle event not found'))
    return
  }

  const parsed = UpdateEventSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json(apiError(ERROR_CODES.VALIDATION_FAILED, 'Validation failed', undefined, parsed.error.flatten()))
    return
  }
  const { data } = parsed
  const { sourceLabel, inputWeightKg, outputs: outputUpdates } = data

  const existingOutputById = new Map(existing.outputs.map((o) => [o.id, o]))
  if (outputUpdates !== undefined) {
    for (const u of outputUpdates) {
      if (!existingOutputById.has(u.id)) {
        res.status(HTTP_STATUS.BAD_REQUEST).json(apiError(ERROR_CODES.DISMANTLE_OUTPUT_FOREIGN, `Output ${u.id} does not belong to this event`, { id: u.id }))
        return
      }
    }
  }

  const event = await prisma.$transaction(async (tx) => {
    if (sourceLabel !== undefined || inputWeightKg !== undefined) {
      await tx.dismantleEvent.update({
        where: { id },
        data: {
          ...(sourceLabel !== undefined && { sourceLabel }),
          ...(inputWeightKg !== undefined && { inputWeightKg })
        }
      })
    }

    const actorUserId = req.user?.id ?? existing.performedBy

    // Sequential for the same read-then-write race reason as the POST
    // handler above — two updated outputs could target the same product.
    /* eslint-disable no-await-in-loop -- see comment above */
    for (const u of outputUpdates ?? []) {
      const before = existingOutputById.get(u.id)
      if (before === undefined) continue
      await applyOutputUpdate(tx, before, u, { eventId: id, actorUserId })
    }
    /* eslint-enable no-await-in-loop */

    return await tx.dismantleEvent.findUniqueOrThrow({
      where: { id },
      include: { outputs: true, template: true }
    })
  })

  res.json(withComputedFields(event))
}))

router.delete('/:id', auth, requireCap('dismantle_carcass'), asyncHandler<AuthRequest>(async (req, res) => {
  const { params } = req
  const { id } = params

  const existing = await prisma.dismantleEvent.findUnique({ where: { id }, include: { outputs: true } })
  if (existing === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json(apiError(ERROR_CODES.DISMANTLE_EVENT_NOT_FOUND, 'Dismantle event not found'))
    return
  }

  await prisma.$transaction(async (tx) => {
    // Give back whatever stock this event contributed, same "reverse via a
    // new ledger entry" pattern as cancelling an order (routes/orders.ts) —
    // the original StockAdjustment from creation is never edited/deleted,
    // this just appends the opposite entry. Can legitimately push a
    // product's stockKg negative if some of it was already sold on — that's
    // real information (this dismantle event's stock is gone but was
    // recorded as available), not something to silently clamp away.
    /* eslint-disable no-await-in-loop -- same same-product race reason as above */
    for (const o of existing.outputs) {
      if (o.productId === null) continue
      const { productId } = o
      const deltaKg = -Number(o.actualWeightKg)
      await tx.product.update({
        where: { id: productId },
        data: { stockKg: { increment: deltaKg } }
      })
      await tx.stockAdjustment.create({
        data: {
          productId,
          deltaKg,
          reason: `Dismantle event ${id} deleted: reversing ${o.cutName} (${existing.sourceLabel})`,
          userId: req.user?.id ?? existing.performedBy
        }
      })
    }
    /* eslint-enable no-await-in-loop */

    await tx.dismantleEventOutput.deleteMany({ where: { eventId: id } })
    await tx.dismantleEvent.delete({ where: { id } })
  })

  res.status(HTTP_STATUS.NO_CONTENT).send()
}))

export default router
