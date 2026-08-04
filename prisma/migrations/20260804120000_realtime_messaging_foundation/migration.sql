-- Durable messaging cursors, idempotency and outbox foundation.
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED');

ALTER TABLE "Conversation"
  ADD COLUMN "nextMessageSequence" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastMessageId" TEXT,
  ADD COLUMN "lastMessageAt" TIMESTAMP(3),
  ADD COLUMN "activityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Message"
  ADD COLUMN "clientMessageId" TEXT,
  ADD COLUMN "sequence" INTEGER;

WITH sequenced AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "conversationId"
      ORDER BY "createdAt", "id"
    )::INTEGER AS sequence
  FROM "Message"
)
UPDATE "Message" AS message
SET
  "clientMessageId" = message."id",
  "sequence" = sequenced.sequence
FROM sequenced
WHERE sequenced."id" = message."id";

ALTER TABLE "Message"
  ALTER COLUMN "clientMessageId" SET NOT NULL,
  ALTER COLUMN "clientMessageId" SET DEFAULT gen_random_uuid()::TEXT,
  ALTER COLUMN "sequence" SET NOT NULL;

WITH latest AS (
  SELECT DISTINCT ON ("conversationId")
    "conversationId",
    "id",
    "createdAt",
    "sequence"
  FROM "Message"
  ORDER BY "conversationId", "sequence" DESC
)
UPDATE "Conversation" AS conversation
SET
  "nextMessageSequence" = latest."sequence",
  "lastMessageId" = latest."id",
  "lastMessageAt" = latest."createdAt",
  "activityAt" = latest."createdAt"
FROM latest
WHERE latest."conversationId" = conversation."id";

CREATE TABLE "ConversationParticipant" (
  "conversationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "lastReadSequence" INTEGER NOT NULL DEFAULT 0,
  "lastReadAt" TIMESTAMP(3),
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationParticipant_pkey" PRIMARY KEY ("conversationId", "userId")
);

INSERT INTO "ConversationParticipant" (
  "conversationId",
  "userId",
  "lastReadSequence",
  "lastReadAt"
)
SELECT
  conversation."id",
  participant."userId",
  COALESCE(read_position."lastReadSequence", 0),
  read_position."lastReadAt"
FROM "Conversation" AS conversation
CROSS JOIN LATERAL (
  VALUES (conversation."buyerId"), (conversation."sellerId")
) AS participant("userId")
LEFT JOIN LATERAL (
  SELECT
    MAX(message."sequence")::INTEGER AS "lastReadSequence",
    MAX(message."readAt") AS "lastReadAt"
  FROM "Message" AS message
  WHERE message."conversationId" = conversation."id"
    AND message."senderId" <> participant."userId"
    AND message."readAt" IS NOT NULL
) AS read_position ON TRUE
ON CONFLICT ("conversationId", "userId") DO NOTHING;

CREATE TABLE "OutboxEvent" (
  "id" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "aggregateType" TEXT NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "messageId" TEXT,
  "clientMessageId" TEXT,
  "conversationId" TEXT,
  "recipientId" TEXT,
  "payload" JSONB NOT NULL,
  "payloadVersion" INTEGER NOT NULL DEFAULT 1,
  "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ConversationParticipant"
  ADD CONSTRAINT "ConversationParticipant_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationParticipant"
  ADD CONSTRAINT "ConversationParticipant_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Message_conversationId_senderId_clientMessageId_key"
  ON "Message"("conversationId", "senderId", "clientMessageId");
CREATE UNIQUE INDEX "Message_conversationId_sequence_key"
  ON "Message"("conversationId", "sequence");
CREATE INDEX "Message_conversationId_sequence_idx"
  ON "Message"("conversationId", "sequence");
CREATE INDEX "Conversation_buyerId_activityAt_idx"
  ON "Conversation"("buyerId", "activityAt");
CREATE INDEX "Conversation_sellerId_activityAt_idx"
  ON "Conversation"("sellerId", "activityAt");
CREATE INDEX "ConversationParticipant_userId_conversationId_idx"
  ON "ConversationParticipant"("userId", "conversationId");
CREATE INDEX "OutboxEvent_status_availableAt_createdAt_idx"
  ON "OutboxEvent"("status", "availableAt", "createdAt");
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_createdAt_idx"
  ON "OutboxEvent"("aggregateType", "aggregateId", "createdAt");

DROP INDEX IF EXISTS "Conversation_buyerId_createdAt_idx";
DROP INDEX IF EXISTS "Conversation_sellerId_createdAt_idx";
DROP INDEX IF EXISTS "Message_conversationId_createdAt_idx";

CREATE OR REPLACE FUNCTION public.remnant_is_conversation_participant(
  target_conversation_id TEXT
)
RETURNS BOOLEAN
SECURITY DEFINER
SET search_path = ''
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."ConversationParticipant" AS participant
    WHERE participant."conversationId" = target_conversation_id
      AND participant."userId" = auth.uid()::text
  );
$$;

REVOKE ALL ON FUNCTION public.remnant_is_conversation_participant(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remnant_is_conversation_participant(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.remnant_broadcast_message_insert()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = ''
LANGUAGE plpgsql
AS $$
DECLARE
  conversation_record public."Conversation"%ROWTYPE;
BEGIN
  UPDATE public."Conversation"
  SET
    "nextMessageSequence" = GREATEST("nextMessageSequence", NEW."sequence"),
    "lastMessageId" = NEW."id",
    "lastMessageAt" = NEW."createdAt",
    "activityAt" = NEW."createdAt",
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."conversationId"
  RETURNING *
  INTO conversation_record
  ;

  PERFORM realtime.broadcast_changes(
    'conversation:' || NEW."conversationId",
    'INSERT',
    'INSERT',
    TG_TABLE_NAME,
    TG_TABLE_SCHEMA,
    NEW,
    OLD
  );

  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'conversation.updated',
      'conversationId', NEW."conversationId",
      'messageId', NEW."id",
      'clientMessageId', NEW."clientMessageId",
      'sequence', NEW."sequence",
      'senderId', NEW."senderId",
      'createdAt', NEW."createdAt"
    ),
    'conversation.updated',
    'user:' || conversation_record."buyerId",
    TRUE
  );

  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'conversation.updated',
      'conversationId', NEW."conversationId",
      'messageId', NEW."id",
      'clientMessageId', NEW."clientMessageId",
      'sequence', NEW."sequence",
      'senderId', NEW."senderId",
      'createdAt', NEW."createdAt"
    ),
    'conversation.updated',
    'user:' || conversation_record."sellerId",
    TRUE
  );

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.remnant_assign_message_sequence()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = ''
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."clientMessageId" IS NULL THEN
    NEW."clientMessageId" = COALESCE(NEW."id", gen_random_uuid()::TEXT);
  END IF;

  IF NEW."sequence" IS NULL THEN
    UPDATE public."Conversation"
    SET
      "nextMessageSequence" = "nextMessageSequence" + 1,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = NEW."conversationId"
    RETURNING "nextMessageSequence" INTO NEW."sequence";
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "Message_assign_sequence"
BEFORE INSERT ON public."Message"
FOR EACH ROW
EXECUTE FUNCTION public.remnant_assign_message_sequence();

REVOKE ALL ON FUNCTION public.remnant_assign_message_sequence() FROM PUBLIC;

CREATE TRIGGER "Message_realtime_insert"
AFTER INSERT ON public."Message"
FOR EACH ROW
EXECUTE FUNCTION public.remnant_broadcast_message_insert();

REVOKE ALL ON FUNCTION public.remnant_broadcast_message_insert() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.remnant_broadcast_read_position()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = ''
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."lastReadSequence" > OLD."lastReadSequence" THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'read.position.updated',
        'conversationId', NEW."conversationId",
        'readerId', NEW."userId",
        'lastReadSequence', NEW."lastReadSequence",
        'readAt', NEW."lastReadAt"
      ),
      'read.position.updated',
      'conversation:' || NEW."conversationId",
      TRUE
    );
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER "ConversationParticipant_realtime_read_position"
AFTER UPDATE OF "lastReadSequence" ON public."ConversationParticipant"
FOR EACH ROW
EXECUTE FUNCTION public.remnant_broadcast_read_position();

REVOKE ALL ON FUNCTION public.remnant_broadcast_read_position() FROM PUBLIC;
