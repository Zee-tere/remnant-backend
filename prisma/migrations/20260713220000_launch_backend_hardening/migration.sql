DROP INDEX IF EXISTS "Review_transactionId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Review_transactionId_reviewerId_key"
  ON "Review"("transactionId", "reviewerId");
CREATE INDEX IF NOT EXISTS "Review_revieweeId_createdAt_idx"
  ON "Review"("revieweeId", "createdAt");

CREATE INDEX IF NOT EXISTS "User_city_idx" ON "User"("city");
CREATE INDEX IF NOT EXISTS "Listing_status_createdAt_idx"
  ON "Listing"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "Listing_status_category_city_createdAt_idx"
  ON "Listing"("status", "category", "city", "createdAt");

WITH ranked AS (
  SELECT
    "id",
    FIRST_VALUE("id") OVER (
      PARTITION BY "listingId", "buyerId", "sellerId"
      ORDER BY "createdAt", "id"
    ) AS keeper_id,
    ROW_NUMBER() OVER (
      PARTITION BY "listingId", "buyerId", "sellerId"
      ORDER BY "createdAt", "id"
    ) AS row_number
  FROM "Conversation"
)
UPDATE "Message" AS message
SET "conversationId" = ranked.keeper_id
FROM ranked
WHERE message."conversationId" = ranked."id"
  AND ranked.row_number > 1;

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "listingId", "buyerId", "sellerId"
      ORDER BY "createdAt", "id"
    ) AS row_number
  FROM "Conversation"
)
DELETE FROM "Conversation" AS conversation
USING ranked
WHERE conversation."id" = ranked."id"
  AND ranked.row_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "Conversation_listingId_buyerId_sellerId_key"
  ON "Conversation"("listingId", "buyerId", "sellerId");
CREATE INDEX IF NOT EXISTS "Conversation_buyerId_createdAt_idx"
  ON "Conversation"("buyerId", "createdAt");
CREATE INDEX IF NOT EXISTS "Conversation_sellerId_createdAt_idx"
  ON "Conversation"("sellerId", "createdAt");
CREATE INDEX IF NOT EXISTS "Message_conversationId_createdAt_idx"
  ON "Message"("conversationId", "createdAt");
CREATE INDEX IF NOT EXISTS "Notification_userId_isRead_createdAt_idx"
  ON "Notification"("userId", "isRead", "createdAt");

ALTER TABLE "Listing"
  ADD CONSTRAINT "Listing_city_nigerian_state_check"
  CHECK (
    "city" IS NULL OR "city" IN (
      'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno',
      'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'Federal Capital Territory',
      'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara',
      'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers',
      'Sokoto', 'Taraba', 'Yobe', 'Zamfara'
    )
  ) NOT VALID;

ALTER TABLE "User"
  ADD CONSTRAINT "User_city_nigerian_state_check"
  CHECK (
    "city" IS NULL OR "city" IN (
      'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno',
      'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'Federal Capital Territory',
      'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara',
      'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers',
      'Sokoto', 'Taraba', 'Yobe', 'Zamfara'
    )
  ) NOT VALID;
