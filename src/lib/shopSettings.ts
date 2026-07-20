import type { ShopSettings } from '@prisma/client'
import { prisma } from './db.js'

// v3 replan (Phase J), extracted v3.1 (Phase L) so both
// routes/shopSettings.ts and the closing-day logic share one
// get-or-create rather than duplicating it. Single-row config table: "how
// long is too long for a pending order" / "what's today's order counter at"
// are shop policy, not per-user preferences.
export async function getOrCreateSettings(): Promise<ShopSettings> {
  const existing = await prisma.shopSettings.findFirst()
  if (existing !== null) return existing
  return await prisma.shopSettings.create({ data: {} })
}
