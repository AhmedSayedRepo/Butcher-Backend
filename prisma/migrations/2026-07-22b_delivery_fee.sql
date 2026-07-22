-- v3.4 — optional flat delivery fee.
--
-- Additive with defaults, so every existing row stays valid and currently
-- deployed code (which never reads these) is unaffected. Existing orders get
-- deliveryFee = 0, which is correct: they were never charged one.
ALTER TABLE "ShopSettings"
  ADD COLUMN IF NOT EXISTS "deliveryFeeEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopSettings"
  ADD COLUMN IF NOT EXISTS "deliveryFee" DECIMAL(10,2) NOT NULL DEFAULT 0;

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "deliveryFee" DECIMAL(10,2) NOT NULL DEFAULT 0;
