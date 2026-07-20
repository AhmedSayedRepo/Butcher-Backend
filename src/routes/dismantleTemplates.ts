import { Router } from 'express'
import { prisma } from '../lib/db.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'

// v2 replan (Phase B.5 — carcass dismantling module). Templates are just
// data (seeded via prisma/seed.ts — 12 templates across calf/sheep/goat, see
// Butcher-Project-Plan-v2.md), not hardcoded here — this route only reads
// them. Read-only, no auth required: any logged-in-or-not viewer can see
// what templates exist, same as GET /api/products today. Recording an
// actual dismantle event (dismantleEvents.ts) is the capability-gated part.
const router = Router()

router.get('/', asyncHandler(async (req, res) => {
  const { animalType } = req.query
  const where = typeof animalType === 'string' && animalType !== '' ? { animalType } : {}
  const templates = await prisma.dismantleTemplate.findMany({
    where,
    include: { cuts: true },
    orderBy: [{ animalType: 'asc' }, { name: 'asc' }]
  })
  res.json(templates)
}))

router.get('/:id', asyncHandler(async (req, res) => {
  const { params } = req
  const { id } = params
  const template = await prisma.dismantleTemplate.findUnique({
    where: { id },
    include: { cuts: true }
  })
  if (template === null) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Template not found' })
    return
  }
  res.json(template)
}))

export default router
