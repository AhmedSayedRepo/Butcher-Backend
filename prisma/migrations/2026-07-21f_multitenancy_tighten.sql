-- Multi-tenancy — plan §7 steps 5-6: NOT NULL + composite unique constraints.
--
-- ############################################################################
-- ##  RUN THIS **AFTER** DEPLOYING THE BACKEND, NOT BEFORE.                  ##
-- ############################################################################
--
-- Unlike the phase 1 migration, this one is NOT safe against the currently
-- running code. Once `organizationId` is NOT NULL, any insert that doesn't set
-- it fails — and the code that sets it is the code being deployed. Run this
-- first and every new order, every cash sale and every stock adjustment starts
-- returning a 500.
--
-- This isn't theoretical. The first attempt at this migration aborted on its
-- own guard: two real cash sales had been rung up between the phase 1 backfill
-- and this migration, by the live old code, with no organizationId. That is
-- exactly the window this ordering closes.
--
-- Correct order:
--   1. Deploy the backend (release.bat).
--   2. Confirm it's up: GET /health returns ok.
--   3. Run this file.
--
-- The backfill is repeated below rather than assumed, because more rows will
-- have been written between the phase 1 migration and this one. It runs in the
-- same transaction as the constraint, so nothing can slip in between.
--
-- IDEMPOTENT: safe to run more than once.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Catch up anything written since phase 1, then lock the columns down.
--
-- Two tables are deliberately NOT made NOT NULL:
--
--   User                — a super admin belongs to no organization. That is
--                         the design (plan §5), not an oversight.
--   PasswordResetToken  — a super admin can forget their password too, and
--                         their token inherits their null organization.
--
-- The guard turns "constraint violation halfway through" into a readable
-- message naming the table and the count.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  target_table TEXT;
  leftovers    BIGINT;
  default_org  TEXT := '00000000-0000-0000-0000-000000000001';
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'Customer', 'CashTransaction', 'ShopSettings', 'IdempotencyKey', 'Product',
    'Order', 'OrderStatusEvent', 'OrderItem', 'StockAdjustment',
    'DismantleEvent', 'DailyClosing', 'DismantleEventOutput'
  ]
  LOOP
    EXECUTE format(
      'UPDATE %I SET "organizationId" = %L WHERE "organizationId" IS NULL',
      target_table, default_org
    );

    EXECUTE format('SELECT count(*) FROM %I WHERE "organizationId" IS NULL', target_table) INTO leftovers;
    IF leftovers > 0 THEN
      RAISE EXCEPTION 'Table % still has % rows with no organizationId', target_table, leftovers;
    END IF;

    EXECUTE format('ALTER TABLE %I ALTER COLUMN "organizationId" SET NOT NULL', target_table);
  END LOOP;
END $$;

-- The two nullable ones still get backfilled — a null organization should mean
-- "super admin", not "old row nobody got round to".
UPDATE "User"               SET "organizationId" = '00000000-0000-0000-0000-000000000001'
  WHERE "organizationId" IS NULL AND "isSuperAdmin" = false;
UPDATE "PasswordResetToken" t SET "organizationId" = u."organizationId"
  FROM "User" u WHERE u.id = t."userId" AND t."organizationId" IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Unique constraints become per-organization
-- ---------------------------------------------------------------------------

-- Supplier-printed barcodes repeat across shops by definition — the same
-- wholesaler serves both — so a global constraint would mean the second shop
-- simply couldn't record the product.
DROP INDEX IF EXISTS "Product_barcode_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Product_organizationId_barcode_key"
  ON "Product"("organizationId", "barcode");

-- 8 random characters, so a cross-shop collision is unlikely rather than
-- impossible — and an unlikely event that blocks a sale is still a bug.
DROP INDEX IF EXISTS "Order_receiptCode_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Order_organizationId_receiptCode_key"
  ON "Order"("organizationId", "receiptCode");

-- Two shops retrying independently must not collide, and a client-generated
-- UUID is not something to bet a double-charge on.
DROP INDEX IF EXISTS "IdempotencyKey_key_endpoint_key";
CREATE UNIQUE INDEX IF NOT EXISTS "IdempotencyKey_organizationId_key_endpoint_key"
  ON "IdempotencyKey"("organizationId", "key", "endpoint");

-- `User.email` stays GLOBALLY unique, deliberately. The plan proposed making
-- it per-organization so one person could work at two shops — but login is by
-- email alone and would then have to know which organization is being logged
-- into, which means the subdomain, which means phase 7 DNS. An ambiguous login
-- is a worse problem than the one it solves. Revisit once subdomains are live;
-- that change is additive.

-- ---------------------------------------------------------------------------
-- 3. Row-level security (plan §4, layer 2)
--
-- Every tenant table already has RLS enabled with no policies, which denies
-- PostgREST entirely — that's the protection that matters here, and it's
-- already in place.
--
-- Deliberately NOT adding per-tenant RLS policies keyed to a session variable.
-- The app connects as the database owner, which BYPASSES RLS regardless of
-- policy, so such policies would protect nothing while looking like they did —
-- and something that looks like a security boundary but isn't is worse than an
-- honest absence. Making them real needs a non-owner role for the app, which
-- is a deployment change (Supabase, Render connection strings, migrations)
-- rather than a SQL one, and belongs in its own piece of work.
--
-- Until then, tenant isolation rests on the Prisma extension (layer 1) and the
-- leak test that proves it (layer 3). That's stated here so nobody reads
-- "RLS enabled" in the dashboard and assumes more than it delivers.
-- ---------------------------------------------------------------------------
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;

COMMIT;
