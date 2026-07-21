-- v3.1 follow-up 10c — banned user accounts.
--
-- A nullable timestamp rather than a boolean, so "when were they cut off?" is
-- answerable later; NULL means active. Enforced both at login and on every
-- authenticated request, so banning someone who is already signed in takes
-- effect immediately rather than whenever their 7-day JWT expires.
--
-- Run in the Supabase SQL Editor for `butcher-cashier` BEFORE deploying the
-- matching backend. Idempotent.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "bannedAt" TIMESTAMP(3);

-- Verify:
--   select column_name from information_schema.columns
--   where table_name = 'User' and column_name = 'bannedAt';
-- Expect 1 row.
