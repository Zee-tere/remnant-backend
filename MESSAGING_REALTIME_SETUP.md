# Remnant messaging: Realtime deployment and rollback

The durable source of truth remains PostgreSQL. Supabase Broadcast accelerates
delivery, while the cursor endpoints provide recovery whenever Realtime is
unavailable.

## Deployment order

1. Apply `20260804120000_realtime_messaging_foundation` with the Prisma migration
   connection (`DIRECT_URL`, session-mode port 5432).
2. Apply `prisma/realtime-authorization.sql` with a Supabase-managed role that
   is permitted to create policies on `realtime.messages`.
3. Set `MESSAGING_REALTIME_ENABLED=true` and deploy the backend. Confirm `POST /auth/supabase-token` and
   `GET /auth/config` work for an authenticated user.
4. Deploy the frontend. Open two authenticated browser sessions and verify send,
   deduplication, read position, typing, reconnect catch-up and older history.
5. Optionally configure the asynchronous outbox relay described below.

The backend keeps legacy unpaginated responses when no cursor parameters are
sent. A compatibility trigger also supplies sequence and client-message IDs for
inserts made by the previous backend. This allows older application instances to
continue working during a rolling deploy.

## Realtime configuration

The Lambda environment requires:

```text
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_JWT_SECRET
SUPABASE_JWT_EXPIRES_IN=15m
MESSAGING_REALTIME_ENABLED=true
```

The Prisma migration installs:

- durable message sequence, idempotency, participant and outbox structures;
- the database trigger functions and application-table triggers.

The separate Supabase authorization script installs:

- participant-aware `SELECT` authorization on `realtime.messages`;
- participant-only `INSERT` authorization for typing broadcasts;
- an `AFTER INSERT` message trigger for `conversation:<id>` and `user:<id>`
  events;
- a participant read-position trigger with a compact payload.

The JWT `sub` is the Remnant `User.id`, which is a UUID and is the identifier
used by both channel policy forms.

On this project, the direct Prisma role currently reports `postgres` while
`realtime.messages` is owned by `supabase_realtime_admin`, and `postgres` is not
a member of that managed role. Supabase documents policy creation on
`realtime.messages` as supported, so an ownership error here requires Supabase
Support to repair the project privileges. Keep `MESSAGING_REALTIME_ENABLED=false`
until the authorization script succeeds; REST recovery remains operational.

## Outbox to SQS

The message transaction writes `OutboxEvent` with the same event ID in the row
and payload. The relay is disabled until `MESSAGING_EVENTS_QUEUE_URL` is set.

Create a Standard or FIFO queue, grant the Lambda execution role
`sqs:SendMessage`, set the queue URL, then invoke the existing Lambda every
minute with an EventBridge event whose `detail-type` is
`RemnantOutboxRelay`. The relay claims rows with `FOR UPDATE SKIP LOCKED`,
recovers abandoned five-minute leases, batches ten SQS entries, and retries with
bounded exponential delay. FIFO queues use the outbox ID for deduplication and
the conversation ID for ordering.

The downstream notification worker must use `eventId` as its idempotency key.
Devices should deduplicate message delivery by `messageId`; `clientMessageId`
is retained for sender-side correlation.

## Monitoring

Track at minimum:

- API send request to database commit;
- database commit to recipient render;
- total send action to recipient render;
- Realtime join failures and reconnects;
- REST recovery calls and recovered event count;
- trigger contribution to transaction p95;
- outbox pending age, retry count and terminal failures;
- Supabase concurrent connections, joins per second and messages per second.

## Fast rollback

Set `MESSAGING_REALTIME_ENABLED=false` on the backend and redeploy its
environment. Clients then use 15-second fallback catch-up plus focus/online
recovery without requiring a frontend rollback.

If database-trigger latency or Realtime itself is implicated, temporarily
disable only the two triggers:

```sql
ALTER TABLE public."Message" DISABLE TRIGGER "Message_realtime_insert";
ALTER TABLE public."ConversationParticipant"
  DISABLE TRIGGER "ConversationParticipant_realtime_read_position";
```

Re-enable them with the corresponding `ENABLE TRIGGER` statements. Do not drop
message sequence, client-message ID, participant cursor or outbox columns during
an incident; they are independently useful and removing them would make rollback
destructive.
