ALTER TABLE "Conversation" ADD COLUMN "guestContact" JSONB;

-- Existing guest listings predate public direct contact. Pause them rather than
-- leave buyers with a dead message action; owners can add contact and republish
-- from their existing private management link.
UPDATE "Listing"
SET "status" = 'PAUSED', "version" = "version" + 1
WHERE "isGuestListing" = true
  AND "status" = 'ACTIVE'
  AND (
    "guestContact" IS NULL
    OR "guestContact"->>'method' NOT IN ('WHATSAPP', 'EMAIL', 'TELEGRAM')
    OR COALESCE("guestContact"->>'value', '') = ''
  );
