CREATE TYPE "PairAlertStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

CREATE TABLE "PairAlert" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "city" TEXT,
    "budget" DECIMAL(12,2),
    "compatibilityAttributes" JSONB,
    "embedding" vector(1536),
    "embeddingHash" TEXT,
    "status" "PairAlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastMatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PairAlert_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PairAlertMatch" (
    "id" TEXT NOT NULL,
    "pairAlertId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "scoreBreakdown" JSONB,
    "status" "MatchStatus" NOT NULL DEFAULT 'PENDING',
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PairAlertMatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PairAlert_userId_status_createdAt_idx" ON "PairAlert"("userId", "status", "createdAt");
CREATE INDEX "PairAlert_status_category_city_idx" ON "PairAlert"("status", "category", "city");
CREATE UNIQUE INDEX "PairAlertMatch_pairAlertId_listingId_key" ON "PairAlertMatch"("pairAlertId", "listingId");
CREATE INDEX "PairAlertMatch_pairAlertId_status_score_idx" ON "PairAlertMatch"("pairAlertId", "status", "score");
CREATE INDEX "PairAlertMatch_listingId_idx" ON "PairAlertMatch"("listingId");

ALTER TABLE "PairAlert" ADD CONSTRAINT "PairAlert_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PairAlertMatch" ADD CONSTRAINT "PairAlertMatch_pairAlertId_fkey"
  FOREIGN KEY ("pairAlertId") REFERENCES "PairAlert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PairAlertMatch" ADD CONSTRAINT "PairAlertMatch_listingId_fkey"
  FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve alerts created through the old public-listing flow, then hide those
-- legacy records from the marketplace.
INSERT INTO "PairAlert" (
  "id", "userId", "query", "description", "category", "city", "budget",
  "compatibilityAttributes", "embedding", "embeddingHash", "status",
  "lastMatchedAt", "createdAt", "updatedAt"
)
SELECT
  l."id", l."userId", COALESCE(NULLIF(l."pairingKeyword", ''), l."title"),
  l."description", l."category", l."city", l."price",
  l."compatibilityAttributes", l."embedding", COALESCE(l."embeddingHash", l."embeddingTextHash"),
  CASE WHEN l."status" = 'ACTIVE' THEN 'ACTIVE'::"PairAlertStatus"
       WHEN l."status" = 'PAUSED' THEN 'PAUSED'::"PairAlertStatus"
       ELSE 'ARCHIVED'::"PairAlertStatus" END,
  l."lastMatchedAt", l."createdAt", l."updatedAt"
FROM "Listing" l
WHERE l."intentionTag" = 'WANTED';

INSERT INTO "PairAlertMatch" (
  "id", "pairAlertId", "listingId", "score", "scoreBreakdown", "status", "notifiedAt", "createdAt"
)
SELECT
  m."id",
  CASE WHEN a."intentionTag" = 'WANTED' THEN a."id" ELSE b."id" END,
  CASE WHEN a."intentionTag" = 'WANTED' THEN b."id" ELSE a."id" END,
  m."score", m."scoreBreakdown", m."status", m."notifiedAt", m."createdAt"
FROM "Match" m
JOIN "Listing" a ON a."id" = m."listingAId"
JOIN "Listing" b ON b."id" = m."listingBId"
WHERE (a."intentionTag" = 'WANTED') <> (b."intentionTag" = 'WANTED')
ON CONFLICT ("pairAlertId", "listingId") DO NOTHING;

DELETE FROM "Match"
WHERE "listingAId" IN (SELECT "id" FROM "Listing" WHERE "intentionTag" = 'WANTED')
   OR "listingBId" IN (SELECT "id" FROM "Listing" WHERE "intentionTag" = 'WANTED');

UPDATE "Listing" SET "status" = 'PAUSED' WHERE "intentionTag" = 'WANTED';
