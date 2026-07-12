CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "Listing"
  ADD COLUMN IF NOT EXISTS "embedding" vector(1536),
  ADD COLUMN IF NOT EXISTS "embeddingHash" TEXT;

CREATE INDEX IF NOT EXISTS "Listing_embedding_ivfflat_idx"
  ON "Listing" USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);
