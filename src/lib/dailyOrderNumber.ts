import type { TransactionClient } from './db.js'

// v3.1 replan (Phase L — daily order numbering + closing day, ADR-015).
// Assigns the next sequential per-day order number ("#1", "#2", ...) by
// atomically incrementing ShopSettings.dailyOrderCounter — a single-row
// shop-wide value, same pattern as pendingOrderAlertMinutes. Must be called
// from inside the caller's own order-creation transaction so two concurrent
// submits (a busy shift, a double-tap) can never receive the same number:
// Prisma's `increment` is a DB-side atomic op, not a JS read-then-write.
//
// Reset to 0 by POST /api/shop-settings/close-day (the "closing day" button
// in Cash Management), so the first order of the next day gets #1 again.
const FIRST_DAILY_NUMBER = 1

export async function nextDailyOrderNumber(tx: TransactionClient): Promise<number> {
  const existing = await tx.shopSettings.findFirst()
  if (existing === null) {
    const created = await tx.shopSettings.create({ data: { dailyOrderCounter: FIRST_DAILY_NUMBER } })
    return created.dailyOrderCounter
  }
  const updated = await tx.shopSettings.update({
    where: { id: existing.id },
    data: { dailyOrderCounter: { increment: FIRST_DAILY_NUMBER } }
  })
  return updated.dailyOrderCounter
}
