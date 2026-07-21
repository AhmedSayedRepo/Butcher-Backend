-- v3.1 follow-up 10b — delivery person on an order, with a shop-configurable label.
--
-- `Order.deliveryName` is free text rather than a User relation: a delivery is
-- often handed to someone with no login at all. It shows on the kanban card and
-- in the order detail, and deliberately never on the printed receipt — it's
-- internal dispatch information, not something the customer needs.
--
-- `ShopSettings.deliveryNameLabel` is just the display label, because shops call
-- this role different things (Driver / Courier / Delivery / a name in Arabic).
--
-- Run in the Supabase SQL Editor for `butcher-cashier` BEFORE deploying the
-- matching backend — same ordering rule as every migration in this folder.
-- Idempotent.

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "deliveryName" TEXT;

ALTER TABLE "ShopSettings"
  ADD COLUMN IF NOT EXISTS "deliveryNameLabel" TEXT NOT NULL DEFAULT 'Delivery';

-- Verify:
--   select column_name from information_schema.columns
--   where (table_name = 'Order' and column_name = 'deliveryName')
--      or (table_name = 'ShopSettings' and column_name = 'deliveryNameLabel');
-- Expect 2 rows.
