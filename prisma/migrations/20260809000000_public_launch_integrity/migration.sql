ALTER TABLE "User"
ADD COLUMN "isPublicProfile" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "showStateOnProfile" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "deactivatedAt" TIMESTAMP(3),
ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);

ALTER TABLE "Listing"
ADD COLUMN "clientRequestId" TEXT;

CREATE UNIQUE INDEX "Listing_userId_clientRequestId_key"
ON "Listing"("userId", "clientRequestId");

CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'ATTACHED', 'DELETED');
ALTER TYPE "ReportTarget" ADD VALUE IF NOT EXISTS 'CONVERSATION';
ALTER TYPE "ReportTarget" ADD VALUE IF NOT EXISTS 'MESSAGE';
CREATE TYPE "SupportRequestStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED');

CREATE TABLE "SupportRequest" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "status" "SupportRequestStatus" NOT NULL DEFAULT 'OPEN',
  "resolution" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupportRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SupportRequest_status_createdAt_idx" ON "SupportRequest"("status", "createdAt");
CREATE INDEX "SupportRequest_email_createdAt_idx" ON "SupportRequest"("email", "createdAt");

CREATE TABLE "Upload" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "listingId" TEXT,
  "s3Key" TEXT NOT NULL,
  "status" "UploadStatus" NOT NULL DEFAULT 'PENDING',
  "byteSize" INTEGER NOT NULL,
  "mimeType" TEXT NOT NULL,
  "attachedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Upload_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Upload_s3Key_key" ON "Upload"("s3Key");
CREATE INDEX "Upload_ownerId_status_createdAt_idx" ON "Upload"("ownerId", "status", "createdAt");
CREATE INDEX "Upload_listingId_idx" ON "Upload"("listingId");
CREATE INDEX "Upload_status_createdAt_idx" ON "Upload"("status", "createdAt");

ALTER TABLE "Upload"
ADD CONSTRAINT "Upload_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Upload"
ADD CONSTRAINT "Upload_listingId_fkey"
FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "Upload" (
  "id", "ownerId", "listingId", "s3Key", "status", "byteSize", "mimeType", "attachedAt", "createdAt", "updatedAt"
)
SELECT
  'legacy-' || md5(listing.id || ':' || image.key),
  listing."userId",
  listing.id,
  image.key,
  'ATTACHED'::"UploadStatus",
  0,
  'application/octet-stream',
  listing."createdAt",
  listing."createdAt",
  CURRENT_TIMESTAMP
FROM "Listing" listing
CROSS JOIN LATERAL unnest(listing.images) AS image(key)
ON CONFLICT ("s3Key") DO NOTHING;
