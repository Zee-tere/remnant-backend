-- Additive listing/search/matching hardening. Existing APIs continue to use the
-- original columns while workers and cursor-based reads adopt the new fields.

CREATE TYPE "MatchingJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

ALTER TABLE "Listing"
  ADD COLUMN "embeddingModel" TEXT,
  ADD COLUMN "embeddingPipelineVersion" INTEGER,
  ADD COLUMN "embeddedAt" TIMESTAMP(3),
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "matchedVersion" INTEGER,
  ADD COLUMN "matchingAlgorithmVersion" TEXT,
  ADD COLUMN "searchDocument" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("pairingKeyword", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("category", '')), 'B') ||
    setweight(to_tsvector('simple', coalesce("city", '')), 'B') ||
    setweight(to_tsvector('simple', coalesce("description", '')), 'C')
  ) STORED;

ALTER TABLE "PairAlert"
  ADD COLUMN "embeddingModel" TEXT,
  ADD COLUMN "embeddingPipelineVersion" INTEGER,
  ADD COLUMN "embeddedAt" TIMESTAMP(3),
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "matchedVersion" INTEGER,
  ADD COLUMN "matchingAlgorithmVersion" TEXT,
  ADD COLUMN "searchDocument" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("query", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("category", '')), 'B') ||
    setweight(to_tsvector('simple', coalesce("description", '')), 'C')
  ) STORED;

ALTER TABLE "Match"
  ADD COLUMN "updatedAt" TIMESTAMP(3),
  ADD COLUMN "algorithmVersion" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "listingAVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "listingBVersion" INTEGER NOT NULL DEFAULT 1;
UPDATE "Match" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;
ALTER TABLE "Match" ALTER COLUMN "updatedAt" SET NOT NULL;

ALTER TABLE "PairAlertMatch"
  ADD COLUMN "updatedAt" TIMESTAMP(3),
  ADD COLUMN "algorithmVersion" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "alertVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "listingVersion" INTEGER NOT NULL DEFAULT 1;
UPDATE "PairAlertMatch" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;
ALTER TABLE "PairAlertMatch" ALTER COLUMN "updatedAt" SET NOT NULL;

CREATE TABLE "MatchParticipantState" (
  "matchId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "MatchStatus" NOT NULL DEFAULT 'PENDING',
  "viewedAt" TIMESTAMP(3),
  "dismissedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MatchParticipantState_pkey" PRIMARY KEY ("matchId", "userId")
);

ALTER TABLE "MatchParticipantState" ADD CONSTRAINT "MatchParticipantState_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatchParticipantState" ADD CONSTRAINT "MatchParticipantState_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "MatchParticipantState" ("matchId", "userId", "status", "viewedAt", "dismissedAt")
SELECT state."matchId", state."userId", state."status", state."viewedAt", state."dismissedAt"
FROM (
  SELECT m."id" AS "matchId", l."userId", m."status",
    CASE WHEN m."status" = 'VIEWED' THEN m."createdAt" ELSE NULL END AS "viewedAt",
    CASE WHEN m."status" = 'DISMISSED' THEN m."createdAt" ELSE NULL END AS "dismissedAt"
  FROM "Match" m
  JOIN "Listing" l ON l."id" = m."listingAId"
  UNION
  SELECT m."id" AS "matchId", l."userId", m."status",
    CASE WHEN m."status" = 'VIEWED' THEN m."createdAt" ELSE NULL END AS "viewedAt",
    CASE WHEN m."status" = 'DISMISSED' THEN m."createdAt" ELSE NULL END AS "dismissedAt"
  FROM "Match" m
  JOIN "Listing" l ON l."id" = m."listingBId"
) AS state
ON CONFLICT ("matchId", "userId") DO NOTHING;

CREATE TABLE "MatchingJob" (
  "id" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "entityVersion" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "MatchingJobStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MatchingJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MatchingJob_entityType_check" CHECK ("entityType" IN ('Listing', 'PairAlert'))
);

CREATE UNIQUE INDEX "MatchingJob_entityType_entityId_entityVersion_key"
  ON "MatchingJob"("entityType", "entityId", "entityVersion");
CREATE INDEX "MatchingJob_status_availableAt_createdAt_idx"
  ON "MatchingJob"("status", "availableAt", "createdAt");
CREATE INDEX "MatchingJob_entityType_entityId_createdAt_idx"
  ON "MatchingJob"("entityType", "entityId", "createdAt");
CREATE INDEX "MatchParticipantState_userId_status_updatedAt_idx"
  ON "MatchParticipantState"("userId", "status", "updatedAt");

CREATE INDEX "Listing_active_feed_cursor_idx"
  ON "Listing"("createdAt" DESC, "id" DESC)
  WHERE "status" = 'ACTIVE' AND "intentionTag" <> 'WANTED';
CREATE INDEX "Listing_active_category_cursor_idx"
  ON "Listing"("category", "createdAt" DESC, "id" DESC)
  WHERE "status" = 'ACTIVE' AND "intentionTag" <> 'WANTED';
CREATE INDEX "Listing_active_city_cursor_idx"
  ON "Listing"("city", "createdAt" DESC, "id" DESC)
  WHERE "status" = 'ACTIVE' AND "intentionTag" <> 'WANTED';
CREATE INDEX "Listing_active_intent_cursor_idx"
  ON "Listing"("intentionTag", "createdAt" DESC, "id" DESC)
  WHERE "status" = 'ACTIVE' AND "intentionTag" <> 'WANTED';
CREATE INDEX "Listing_userId_createdAt_idx" ON "Listing"("userId", "createdAt" DESC);
CREATE INDEX "SavedListing_userId_createdAt_idx" ON "SavedListing"("userId", "createdAt" DESC);
CREATE INDEX "Listing_searchDocument_gin_idx" ON "Listing" USING GIN ("searchDocument");
CREATE INDEX "PairAlert_searchDocument_gin_idx" ON "PairAlert" USING GIN ("searchDocument");
CREATE INDEX "Listing_compatibilityAttributes_gin_idx"
  ON "Listing" USING GIN ("compatibilityAttributes" jsonb_path_ops);
CREATE INDEX "PairAlert_compatibilityAttributes_gin_idx"
  ON "PairAlert" USING GIN ("compatibilityAttributes" jsonb_path_ops);

-- The old IVFFlat index was trained before an embedded corpus existed. HNSW
-- does not require that training step and behaves better for filtered ANN reads.
DROP INDEX IF EXISTS "Listing_embedding_ivfflat_idx";
CREATE INDEX "Listing_embedding_hnsw_idx"
  ON "Listing" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "PairAlert_embedding_hnsw_idx"
  ON "PairAlert" USING hnsw ("embedding" vector_cosine_ops);
