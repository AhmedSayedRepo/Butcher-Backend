// v2 replan (Phase B) added `Product.lowStockAlertKg` as a per-product
// override of the shop-wide default — falls back to the default when unset.
// v3.1 follow-up 5 (Settings page): the shop-wide default used to be a
// hardcoded constant duplicated here and in two frontend files
// (app/page.tsx, app/inventory/page.tsx). It's now `ShopSettings.
// defaultLowStockThresholdKg`, editable from /settings — callers fetch the
// current value (`getOrCreateSettings()`) and pass it in, rather than this
// module reaching into the DB itself. `FALLBACK_LOW_STOCK_THRESHOLD_KG`
// only matters if a caller somehow can't load settings at all.
export const FALLBACK_LOW_STOCK_THRESHOLD_KG = 5

export function isLowStock(product: { stockKg: unknown, lowStockAlertKg: unknown }, shopDefaultThresholdKg: number = FALLBACK_LOW_STOCK_THRESHOLD_KG): boolean {
  const threshold = product.lowStockAlertKg === null || product.lowStockAlertKg === undefined
    ? shopDefaultThresholdKg
    : Number(product.lowStockAlertKg)
  return Number(product.stockKg) < threshold
}
