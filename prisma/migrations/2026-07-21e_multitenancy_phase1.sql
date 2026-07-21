-- Multi-tenancy, phase 1 — Butcher-Multi-Tenancy-Plan.md §2 and §7 steps 1-4.
--
-- WHAT THIS DOES
--   1. Creates the Organization table.
--   2. Inserts one row for your existing shop.
--   3. Adds a NULLABLE "organizationId" to all 14 tenant-scoped tables.
--   4. Backfills every existing row to that organization.
--
-- WHAT IT DELIBERATELY DOES *NOT* DO
--   - It does not add NOT NULL. The code currently running in production
--     doesn't know these columns exist, so it inserts rows without them; a
--     NOT NULL constraint would start rejecting real orders the moment this
--     ran. NOT NULL lands in a later migration, together with the code that
--     populates the column.
--   - It does not touch the existing unique constraints. `User.email`,
--     `Product.barcode` and `Order.receiptCode` stay globally unique for now;
--     they become composite (per-organization) in that same later migration.
--     Changing them early would be harmless today but pointless — nothing
--     depends on it until there are two organizations.
--
-- SAFE TO RUN AGAINST THE LIVE DATABASE WITH THE CURRENT CODE DEPLOYED.
--   Adding a nullable column and backfilling it is invisible to code that
--   never mentions the column. There is no window where the app is broken,
--   which matters because the schema and the code deploy separately here.
--
-- IDEMPOTENT: safe to run more than once.
--
-- AFTERWARDS: run `npx prisma generate` so the client knows about the new
-- columns. Nothing in the backend reads them yet, so `tsc` passes either way.
--
-- ALREADY APPLIED to the butcher-cashier Supabase project on 2026-07-21 via
-- the Supabase MCP connection. This file is the record of what ran; you only
-- need to run it by hand if you rebuild the database from scratch.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The Organization table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Organization" (
  "id"                 TEXT PRIMARY KEY,
  -- The subdomain, and therefore the routing key. Unique globally: a
  -- duplicate wouldn't be untidy, it would be ambiguous.
  "slug"               TEXT NOT NULL,
  "name"               TEXT NOT NULL,
  "email"              TEXT NOT NULL,
  "phone"              TEXT,
  "address"            TEXT,
  -- Billing (plan §8a). No payment provider yet — these are set by hand from
  -- the super-admin screen until there are customers to bill.
  "plan"               TEXT NOT NULL DEFAULT 'trial',
  "billingStatus"      TEXT NOT NULL DEFAULT 'active',
  "trialEndsAt"        TIMESTAMP(3),
  "billingEmail"       TEXT,
  "externalCustomerId" TEXT,
  -- Soft delete. Archiving refuses sign-in; the data stays, because an
  -- organization's rows are its cash ledger and order history.
  "archivedAt"         TIMESTAMP(3),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "Organization_slug_key" ON "Organization"("slug");
CREATE INDEX IF NOT EXISTS "Organization_archivedAt_idx" ON "Organization"("archivedAt");

-- ---------------------------------------------------------------------------
-- 2. Your existing shop becomes organization #1
--
-- Fixed id rather than a generated uuid, so this file is idempotent and so
-- you can refer to the same row from a later migration without looking it up.
-- Edit the name/email/phone/address below if you want them right from the
-- start; they're editable from the app later either way.
-- ---------------------------------------------------------------------------
INSERT INTO "Organization" ("id", "slug", "name", "email", "plan", "billingStatus")
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'default',
  'Butcher Cashier',
  'admin@butcher.app',
  'pro',
  'active'
)
ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Nullable organizationId on every tenant-scoped table
--
-- One ALTER per table rather than a loop: explicit is easier to read in a
-- diff, and easier to comment out if one table needs different handling.
-- ---------------------------------------------------------------------------
ALTER TABLE "User"                 ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "PasswordResetToken"   ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "Customer"             ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "CashTransaction"      ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "ShopSettings"         ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "IdempotencyKey"       ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "Product"              ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "Order"                ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "OrderStatusEvent"     ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "OrderItem"            ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "StockAdjustment"      ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "DismantleEvent"       ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "DailyClosing"         ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "DismantleEventOutput" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- ---------------------------------------------------------------------------
-- 4. Backfill — every existing row belongs to organization #1
--
-- `WHERE "organizationId" IS NULL` is what makes this re-runnable: a second
-- run touches nothing, and a row that somehow already has a different
-- organization is left alone rather than being reassigned.
-- ---------------------------------------------------------------------------
UPDATE "User"                 SET "organizationId" = '00000000-0000-0000-0000-000000000001' WHERE "organizationId" IS NULL;
UPDATE "PasswordResetToken"   SET "organizationId" = '00000000-0000-0000-0000-000000000001' WHERE "organizationId" IS NULL;
UPDATE "Customer"             SET "organizationId" = '00000000-0000-0000-0000-000000000001' WHERE "organizationId" IS NULL;
UPDATE "CashTransaction"      SET "organizationId" = '00000000-0000-0000-0000-000000000001' WHERE "organizationId" IS NULL;
UPDATE "ShopSettings"         SET "organizationId" = '00000000-0000-0000-0000-000000000001' WHERE "organizationId" IS NULL;
UPDATE "IdempotencyKey"       SET "organizationId" = '00000000-0000-0000-0000-000000000001' WHERE "organizationId" IS NULL;
UPDATE "Product"              SET "organizationId" = '00000000-0000-0000-0000-000000000001' WHERE "organizationId" IS NULL;
UPDATE "Order"                SET "organizationId" = '00000000-0000-0000-0000-000000000001' WHERE "organizationId" IS NULL;
UPDATE "OrderStatusEvent"     SET "organizationId" = '00000000-0000-0000-0000-000000000001' WHERE "organizationId" IS NULL;
UPDATE "OrderItem"            SET "organizationId" = '00000000-0000-0000-0000-000000000001' WHERE "organizationId" IS NULL;
UPDATE "StockAdjustment"      SET "organizationId" = '00000000-0000-0000-0000-000000000001' WHERE "organizationId" IS NULL;
UPDATE "DismantleEvent"       SET "organizationId" = '00000000-0000-0000-0000-000000000001' WHERE "organizationId" IS NULL;
UPDATE "DailyClosing"         SET "organizationId" = '00000000-0000-0000-0000-000000000001' WHERE "organizationId" IS NULL;
UPDATE "DismantleEventOutput" SET "organizationId" = '00000000-0000-0000-0000-000000000001' WHERE "organizationId" IS NULL;

-- ---------------------------------------------------------------------------
-- 5. Foreign keys and indexes
--
-- FKs go on AFTER the backfill: added before, they'd be satisfied trivially
-- (every value is NULL) — after, they actually verify that what we just wrote
-- points at a real organization.
--
-- ON DELETE RESTRICT is the point of the soft-delete design: even if someone
-- runs `DELETE FROM "Organization"` by hand, Postgres refuses while a single
-- order still references it.
--
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, hence the DO block —
-- without it a second run of this file would fail on a duplicate name.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  target_table TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'User', 'PasswordResetToken', 'Customer', 'CashTransaction', 'ShopSettings',
    'IdempotencyKey', 'Product', 'Order', 'OrderStatusEvent', 'OrderItem',
    'StockAdjustment', 'DismantleEvent', 'DailyClosing', 'DismantleEventOutput'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = target_table || '_organizationId_fkey'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("organizationId")
           REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
        target_table, target_table || '_organizationId_fkey'
      );
    END IF;

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I ("organizationId")',
      target_table || '_organizationId_idx', target_table
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Row-level security on the new table
--
-- Supabase exposes the `public` schema through PostgREST, so a table with RLS
-- *disabled* is readable by anyone holding the project's anon key. Every other
-- table here is RLS-enabled with no policies, which denies that path entirely.
-- Organization was created without it and was briefly the one readable table —
-- and it holds customer names, emails, phones and billing status.
--
-- No effect on the app: Prisma connects as the database owner, which bypasses
-- RLS. That bypass is also why plan §4 treats RLS as the *second* layer and
-- the query-level filter as the first.
-- ---------------------------------------------------------------------------
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verify: every count below should be 0. A non-zero row means a table still
-- has unassigned rows, which would break the NOT NULL migration later.
-- ---------------------------------------------------------------------------
-- SELECT 'User' AS t, count(*) FROM "User" WHERE "organizationId" IS NULL
-- UNION ALL SELECT 'Customer', count(*) FROM "Customer" WHERE "organizationId" IS NULL
-- UNION ALL SELECT 'Product', count(*) FROM "Product" WHERE "organizationId" IS NULL
-- UNION ALL SELECT 'Order', count(*) FROM "Order" WHERE "organizationId" IS NULL
-- UNION ALL SELECT 'OrderItem', count(*) FROM "OrderItem" WHERE "organizationId" IS NULL
-- UNION ALL SELECT 'OrderStatusEvent', count(*) FROM "OrderStatusEvent" WHERE "organizationId" IS NULL
-- UNION ALL SELECT 'CashTransaction', count(*) FROM "CashTransaction" WHERE "organizationId" IS NULL
-- UNION ALL SELECT 'StockAdjustment', count(*) FROM "StockAdjustment" WHERE "organizationId" IS NULL
-- UNION ALL SELECT 'ShopSettings', count(*) FROM "ShopSettings" WHERE "organizationId" IS NULL
-- UNION ALL SELECT 'DismantleEvent', count(*) FROM "DismantleEvent" WHERE "organizationId" IS NULL
-- UNION ALL SELECT 'DismantleEventOutput', count(*) FROM "DismantleEventOutput" WHERE "organizationId" IS NULL
-- UNION ALL SELECT 'DailyClosing', count(*) FROM "DailyClosing" WHERE "organizationId" IS NULL
-- UNION ALL SELECT 'PasswordResetToken', count(*) FROM "PasswordResetToken" WHERE "organizationId" IS NULL
-- UNION ALL SELECT 'IdempotencyKey', count(*) FROM "IdempotencyKey" WHERE "organizationId" IS NULL;
