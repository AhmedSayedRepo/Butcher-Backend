// Mirrors the frontend's LOW_STOCK_THRESHOLD_KG constant
// (frontend/app/inventory/page.tsx) so both sides agree on what "low stock"
// means for a product with no per-product override. v2 replan (Phase B)
// added `Product.lowStockAlertKg` as a per-product override of this global —
// falls back to this constant when unset, additive, nothing breaks.
export const DEFAULT_LOW_STOCK_THRESHOLD_KG = 5

export function isLowStock(product: { stockKg: unknown, lowStockAlertKg: unknown }): boolean {
  const threshold = product.lowStockAlertKg === null || product.lowStockAlertKg === undefined
    ? DEFAULT_LOW_STOCK_THRESHOLD_KG
    : Number(product.lowStockAlertKg)
  return Number(product.stockKg) < threshold
}
