-- v3.1 follow-up 10 — printed-receipt customization (/settings).
--
-- Adds the ShopSettings columns behind the new Receipt section: paper size,
-- font scale, custom header/footer text, an optional logo, per-field show
-- toggles, and the shop's own contact details (which had no home before —
-- the app only knew its name as a hardcoded UI string).
--
-- Apply this in the Supabase SQL Editor for the `butcher-cashier` project
-- BEFORE deploying the matching backend, exactly like the Brevo rename:
-- the Prisma client will select these columns, so a deploy that runs ahead
-- of the migration breaks every ShopSettings read (dashboard, /settings,
-- low-stock, daily order numbering), not just the receipt.
--
-- Idempotent — safe to run more than once.

ALTER TABLE "ShopSettings"
  ADD COLUMN IF NOT EXISTS "receiptWidthMm"      INTEGER        NOT NULL DEFAULT 80,
  ADD COLUMN IF NOT EXISTS "receiptHeightMm"     INTEGER,
  ADD COLUMN IF NOT EXISTS "receiptFontScale"    DECIMAL(3, 2)  NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "receiptHeaderText"   TEXT,
  ADD COLUMN IF NOT EXISTS "receiptFooterText"   TEXT,
  ADD COLUMN IF NOT EXISTS "receiptLogoUrl"      TEXT,
  ADD COLUMN IF NOT EXISTS "receiptShowShopName" BOOLEAN        NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "receiptShowPhone"    BOOLEAN        NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "receiptShowAddress"  BOOLEAN        NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "receiptShowOrderNo"  BOOLEAN        NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "receiptShowCode"     BOOLEAN        NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "receiptShowCashier"  BOOLEAN        NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "receiptShowDateTime" BOOLEAN        NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "shopName"            TEXT           NOT NULL DEFAULT 'Butcher Cashier',
  ADD COLUMN IF NOT EXISTS "shopPhone"           TEXT,
  ADD COLUMN IF NOT EXISTS "shopAddress"         TEXT;

-- Verify:
--   select column_name from information_schema.columns
--   where table_name = 'ShopSettings' and column_name like 'receipt%';
-- Expect 13 rows.
