-- Guest listings are intentionally short-lived. Existing active guest listings
-- receive the same seven-day lifetime measured from their original creation.
UPDATE "Listing"
SET "expiresAt" = LEAST(
  COALESCE("expiresAt", "createdAt" + INTERVAL '7 days'),
  "createdAt" + INTERVAL '7 days'
)
WHERE "isGuestListing" = true
  AND status IN ('ACTIVE', 'PAUSED', 'EXPIRED', 'COMPLETED');
