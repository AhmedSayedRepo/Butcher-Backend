-- v3.3 — weighing-scale (variable-measure) barcode support.
--
-- Two additive, nullable columns; safe to run against live, currently-deployed
-- code, which simply never reads or writes them. Run this AFTER deploying the
-- v3.3 backend is not required for safety (the columns are additive), but the
-- app only USES them once that code is live.
--
-- Product.scaleItemCode: the item/PLU segment a scale embeds in its labels.
-- Unique per organization, NULLs distinct — same shape as barcode, so
-- unbarcoded products and shops that don't use scales are unaffected.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "scaleItemCode" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Product_organizationId_scaleItemCode_key"
  ON "Product" ("organizationId", "scaleItemCode");

-- ShopSettings.scaleBarcodeConfig: the per-shop scheme (prefix, field
-- positions, weight|price, divisor, check-digit). JSONB, null until configured.
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "scaleBarcodeConfig" JSONB;
