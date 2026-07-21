-- v3.1 follow-up 10e — app logo.
--
-- The nav rail's logo, stored alongside the receipt logo but separate from it:
-- the receipt one is printed on a thermal printer, this one is shown on
-- screen, and a shop may well want different images (or only one of the two).
--
-- Both columns hold either an `https://` URL or a `data:image/...;base64,...`
-- URL. The settings form downscales an uploaded file and stores it as a data
-- URL, so a shop with nowhere to host an image can still set a logo without
-- this project needing object storage.
--
-- Idempotent: safe to run more than once.

ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "appLogoUrl" TEXT;
