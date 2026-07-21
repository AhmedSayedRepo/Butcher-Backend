import { Router } from 'express'
import { prisma } from '../lib/db.js'
import { auth } from '../middleware/auth.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'
import { apiError, ERROR_CODES } from '../lib/errorCodes.js'

// v2 replan (Phase B.5 — carcass dismantling module). Templates are just
// data (seeded via prisma/seed.ts — 12 templates across calf/sheep/goat, see
// Butcher-Project-Plan-v2.md), not hardcoded here — this route only reads
// them. Read-only and login-gated (v3.1 follow-up 10d — it used to be open to
// anyone, which made sense only while the app had anonymous surfaces).
// Recording an actual dismantle event (dismantleEvents.ts) is the
// capability-gated part.
const router = Router()

// v3.1 follow-up 10d: was public. Reference data rather than a secret, but
// there's no reason to serve the shop's carcass-breakdown setup anonymously.
router.get('/', auth, asyncHandler(async (req, res) => {
  const { query } = req
  const { animalType } = query
  const where = typeof animalType === 'string' && animalType !== '' ? { animalType } : {}
  const templates = await prisma.dismantleTemplate.findMany({
    where,
    include: { cuts: true },
    orderBy: [{ animalType: 'asc' }, { name: 'asc' }]
  })
  res.json(templates)
}))

router.get('/:id', auth, asyncHandler(async (req, res) => {
  const { params } = req
  const { id } = params
  const template = await prisma.dismantleTemplate.findUnique({
    where: { id },
    include: { cuts: true }
  })
  if (template === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json(apiError(ERROR_CODES.TEMPLATE_NOT_FOUND, 'Template not found'))
    return
  }
  res.json(template)
}))

export default router
