ALTER TABLE "Listing"
ADD COLUMN "isGuestListing" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "guestContact" JSONB;

UPDATE "Listing"
SET "isGuestListing" = true
WHERE LOWER(COALESCE("compatibilityAttributes" ->> 'guestListing', '')) = 'true';
