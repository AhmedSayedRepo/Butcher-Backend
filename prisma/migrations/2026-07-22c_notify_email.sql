-- v3.5 — per-shop notification recipient.
--
-- Additive and nullable, so every existing row stays valid and currently
-- deployed code (which never reads it) is unaffected. Null means the Make
-- scenario falls back to its own default recipient.
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "notifyEmail" TEXT;
