-- Better Auth 1.7.2's core account schema renamed the account lookup key from
-- `providerId` to `issuer`, with a unique index on (issuer, accountId) instead
-- of (providerId, accountId). Its internal adapter (findAccountOwnerByKey /
-- findAccountByKey) queries the `issuer` column directly, so every OAuth
-- callback fails with PrismaClientValidationError until this column exists.
--
-- The column is added nullable first so existing rows are not rejected by the
-- NOT NULL constraint mid-migration, backfilled from `providerId` (the value
-- Better Auth previously wrote there for the same lookup), then tightened to
-- NOT NULL. `providerId` itself is kept: Better Auth 1.7.2 still reads and
-- writes it as a separate field distinct from `issuer`.

-- AddColumn
ALTER TABLE "account" ADD COLUMN "issuer" TEXT;

-- Backfill: for any row written before this column existed, `providerId` was
-- the value Better Auth used as the account lookup key.
UPDATE "account" SET "issuer" = "providerId" WHERE "issuer" IS NULL;

-- AlterColumn
ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;

-- DropIndex
DROP INDEX "account_providerId_accountId_key";

-- CreateIndex
CREATE UNIQUE INDEX "account_issuer_accountId_key" ON "account"("issuer", "accountId");
