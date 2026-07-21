-- ADR-017: Gmail SMTP -> Brevo HTTP transactional email API.
--
-- Renames the two ShopSettings credential columns added by ADR-016. The
-- Prisma schema (backend/prisma/schema.prisma) already expects the new
-- names, so /settings and the invite/reset email path will error against
-- the live DB until this is applied.
--
-- NOT YET APPLIED. The Supabase project (Butcher-Backend,
-- mnlrrfjzcagsznyzdhlh) is paused, and restoring it is blocked by the free
-- tier's 2-active-project-per-owner limit. Apply this once the project is
-- back up -- either via the Supabase SQL editor, or ask Claude to run it.
--
-- Idempotent: safe to run twice, and safe to run against a DB where the
-- rename already happened.
--
-- Data note: any value currently in "smtpAppPasswordEncrypted" is an
-- AES-256-GCM-encrypted *Gmail app password*, not a Brevo API key. The
-- rename carries it over as-is; it will decrypt fine but is meaningless to
-- Brevo, so re-enter the real API key from /settings (or set BREVO_API_KEY
-- on Render) afterwards. Uncomment the final UPDATE below to null them out
-- instead of leaving a dead value in place.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ShopSettings' AND column_name = 'smtpUser'
  ) THEN
    ALTER TABLE "ShopSettings" RENAME COLUMN "smtpUser" TO "brevoSenderEmail";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ShopSettings' AND column_name = 'smtpAppPasswordEncrypted'
  ) THEN
    ALTER TABLE "ShopSettings" RENAME COLUMN "smtpAppPasswordEncrypted" TO "brevoApiKeyEncrypted";
  END IF;
END $$;

-- Optional: clear the carried-over Gmail credentials (see data note above).
-- UPDATE "ShopSettings" SET "brevoSenderEmail" = NULL, "brevoApiKeyEncrypted" = NULL;
