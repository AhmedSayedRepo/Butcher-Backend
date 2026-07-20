import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/db.js'
import { auth } from '../middleware/auth.js'
import { requireRole } from '../middleware/rbac.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'

const router = Router()

// v3 replan (Phase J — pending-order alerting). Single-row config table:
// "how long is too long for a pending order" is shop policy, not a
// per-user preference. GET is open to any authed user (the dashboard's
// polling/alert logic needs to read the threshold regardless of role);
// PATCH is admin-only, same tier as user management — shop-wide policy
// changes, not a day-to-day cashier/manager action.

async function getOrCreateSettings() {
  const existing = await prisma.shopSettings.findFirst()
  if (existing !== null) return existing
  return await prisma.shopSettings.create({ data: {} })
}

router.get('/', auth, asyncHandler(async (_req, res) => {
  const settings = await getOrCreateSettings()
  res.json(settings)
}))

const MIN_ALERT_MINUTES = 1

const UpdateShopSettingsSchema = z.object({
  pendingOrderAlertMinutes: z.number().int().min(MIN_ALERT_MINUTES).optional(),
  alertSoundEnabled: z.boolean().optional()
})

router.patch('/', auth, requireRole('admin'), asyncHandler(async (req, res) => {
  const parsed = UpdateShopSettingsSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: parsed.error.flatten() })
    return
  }
  const current = await getOrCreateSettings()
  const { data } = parsed
  const updated = await prisma.shopSettings.update({ where: { id: current.id }, data })
  res.json(updated)
}))

export default router
