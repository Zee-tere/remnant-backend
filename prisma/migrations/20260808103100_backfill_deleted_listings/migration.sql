-- PAUSED was previously used by every destructive delete path. There is no
-- member-facing pause action, so these rows represent removed inventory.
UPDATE "Listing"
SET "status" = 'DELETED'::"ListingStatus"
WHERE "status" = 'PAUSED'::"ListingStatus";
