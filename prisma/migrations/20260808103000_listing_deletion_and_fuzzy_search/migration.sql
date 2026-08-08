-- Keep removed listings distinguishable from temporarily paused inventory and
-- add typo-tolerant retrieval without changing the public search contract.
ALTER TYPE "ListingStatus" ADD VALUE IF NOT EXISTS 'DELETED';

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Listing_title_trigram_idx"
  ON "Listing" USING GIN (lower("title") gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Listing_pairingKeyword_trigram_idx"
  ON "Listing" USING GIN (lower(coalesce("pairingKeyword", '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Listing_search_text_trigram_idx"
  ON "Listing" USING GIN (
    lower(
      coalesce("title", '') || ' ' ||
      coalesce("pairingKeyword", '') || ' ' ||
      coalesce("category", '') || ' ' ||
      coalesce("city", '') || ' ' ||
      coalesce("description", '')
    ) gin_trgm_ops
  );
