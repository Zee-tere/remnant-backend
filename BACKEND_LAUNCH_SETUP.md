# Remnant Backend Launch Setup

This backend is now aligned with the zero-cost launch architecture from the rewrite brief:

- NestJS REST API packaged for AWS Lambda.
- API Gateway HTTP API in front of `dist/lambda.handler`.
- Supabase PostgreSQL as the database runtime.
- Supabase Realtime for notifications, matches, transactions, and messages.
- Cognito Hosted UI for email/password and Google auth.
- Cognito access-token verification in NestJS via `aws-jwt-verify`.
- Indexed PostgreSQL retrieval first, with opt-in OpenAI embeddings stored in Supabase `pgvector`.
- Durable, versioned matching jobs processed by EventBridge-triggered workers.
- Escrow.com code retained but disabled at launch with `ESCROW_ENABLED=false`.

Docker, EC2, ALB, ECS/Fargate, Aurora/RDS, and API Gateway WebSocket artifacts are intentionally removed from this launch path to avoid baseline monthly cost.

## Local Verification

```bash
npm.cmd run build
npm.cmd test -- --runInBand
npx.cmd prisma generate
```

All three commands pass locally.

## Runtime Entry Points

- Local development: `src/main.ts`
- Lambda HTTP API: `src/lambda.ts`
- EventBridge backfill Lambda: `src/backfill.handler.ts`

Lambda handler:

```text
dist/lambda.handler
```

Backfill handler:

```text
dist/backfill.handler.handler
```

## Database

Use Supabase PostgreSQL.

- Lambda runtime uses the Supabase pooler connection string on port `6543`.
- Prisma migrations use `DIRECT_URL` with the session-mode pooler on port `5432`.
- Supabase's direct host, `db.vcgurglczberpgwwgrcf.supabase.co:5432`, is not IPv4 compatible unless IPv6 is available or the Supabase IPv4 add-on is purchased. Use the session pooler for local Windows/AWS Lambda migration access.
- `pgvector` is enabled by migration `20260531143000_add_pgvector_embeddings`.
- Listing embeddings are stored in `Listing.embedding`.

## Auth

Backend-issued JWTs, Passport strategies, and backend Google OAuth callbacks are removed.

The frontend should send Cognito access tokens as:

```http
Authorization: Bearer <cognito-access-token>
```

Protected routes use `JwtAuthGuard`, which verifies the Cognito token and ensures a local `User` row exists for application relations.

The frontend can request a short-lived Supabase-compatible JWT for Realtime RLS:

```http
POST /auth/supabase-token
Authorization: Bearer <cognito-access-token>
```

## Realtime

Socket.IO is removed. Realtime delivery is database-driven:

- `Notification` inserts
- `Match` inserts/updates
- `Transaction` updates
- `Message` inserts/updates

Enable Supabase Realtime and RLS policies for the relevant tables before launch. Client-side filters are convenience only; RLS is the security boundary.

## Matching And Search

Listing and pair-alert writes commit their data and a versioned `MatchingJob` in
the same transaction. They do not wait for matching or OpenAI. A worker claims
jobs with `FOR UPDATE SKIP LOCKED`, retries failures with backoff, and skips jobs
whose entity version has already been superseded.

Candidate retrieval runs in this order:

1. recent candidates within the hard category/status/user filters;
2. indexed PostgreSQL full-text and JSON compatibility candidates;
3. only when fewer than the configured number of surface matches remain,
   optional pgvector/OpenAI retrieval.

Semantic search is enabled when an OpenAI key and an embedded listing corpus are
available, but it only runs when indexed text retrieval returns fewer than the
configured number of results. Background semantic matching remains off by
default:

```env
SEMANTIC_SEARCH_ENABLED=true
SEMANTIC_SEARCH_MIN_LEXICAL_RESULTS=6
SEMANTIC_MATCHING_ENABLED=false
SEMANTIC_MATCHING_MIN_SURFACE_RESULTS=3
```

Set either semantic flag to `false` to guarantee zero OpenAI calls on that path.
The two paths can be enabled independently after monitoring recall and cost.

Invoke the HTTP Lambda every minute with EventBridge detail type
`RemnantMatchingWorker`, or schedule the separate backfill handler. The regular
backfill only queues stale `(listingId, version)` records; workers perform the
bounded matching passes.

Search endpoint:

```http
GET /listings/search?q=left%20airpod&category=electronics&city=Lagos&intent=SELL
```

Marketplace feeds use deterministic `(createdAt, id)` cursors. UUID ordering is
used only as a stable tie-breaker when timestamps are equal; it does not need to
be sequential.

## Escrow

Set launch default:

```env
ESCROW_ENABLED=false
```

When disabled, transactions are local-only and no Escrow.com API calls are made. The webhook endpoint returns immediately with:

```json
{ "received": true, "note": "escrow disabled" }
```

To re-enable escrow later, set `ESCROW_ENABLED=true`, configure Escrow.com credentials, and redeploy.

## Required Production Parameters

The production Lambda must include the full runtime environment. Copy
`lambda-env.production.example.json` to `lambda-env.production.json`, fill the
real secret values, then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\apply-lambda-env.ps1
```

The script validates required keys, blocks placeholder values, writes UTF-8 JSON
without BOM, updates `remnant-api`, and waits for the Lambda update to finish.

Store long-lived production values in SSM Parameter Store under `/remnant/prod/`
as a follow-up hardening step:

```text
DATABASE_URL
DIRECT_URL
COGNITO_USER_POOL_ID
COGNITO_CLIENT_ID
FRONTEND_URL
ALLOWED_ORIGINS
AWS_REGION
AWS_S3_BUCKET
AWS_S3_PUBLIC_BASE_URL
AWS_SES_REGION
EMAIL_FROM
OPENAI_API_KEY
GUEST_ACCESS_SECRET
SUPABASE_JWT_SECRET
SUPABASE_URL
ESCROW_ENABLED
MATCH_SCORE_THRESHOLD
MATCH_ATTRIBUTE_WEIGHT
MATCH_SEMANTIC_WEIGHT
MATCH_MAX_CANDIDATES
MATCH_PRICE_TOLERANCE_PERCENT
MATCH_REQUIRE_CITY
PLATFORM_FEE_PERCENTAGE
PLATFORM_PAYMENTS_ENABLED
INDEXNOW_KEY
```

`COGNITO_CLIENT_ID` must be the public web app client. Do not use a Cognito app
client with a client secret for the browser flow. The client must allow the
authorization code grant, PKCE, scopes `openid email profile`, callback
`https://remnantmarket.co/auth/callback`, and logout URL
`https://remnantmarket.co`.

### Branded Google sign-in domain

Google displays the Cognito host on its consent handoff. To show Remnant instead
of the raw `*.amazoncognito.com` hostname, attach `auth.remnantmarket.co` as the
user pool's custom domain using an ACM certificate in `us-east-1`, then point the
`auth` DNS record at the CloudFront distribution Cognito provides. After the
domain is active, set:

```env
COGNITO_HOSTED_UI_DOMAIN=https://auth.remnantmarket.co
```

Keep the existing callback and logout URLs on the Cognito app client. Do not
change this environment value before Cognito reports the custom domain as active,
or hosted sign-in will become unavailable.

## Production S3 Buckets

The launch stack creates several buckets with different jobs:

```text
remnant-frontend-production-remnantwebassetsbucket-*  Next/OpenNext frontend assets
remnant-f-production-remnantwebcdnredirectbucketbucket-*  redirect/CDN support bucket
sst-asset-*  SST deployment assets
sst-state-*  SST state
remnant-uploads-prod  user listing uploads
```

Only `remnant-uploads-prod` should be used by the backend upload service:

```env
AWS_REGION=us-east-1
AWS_S3_BUCKET=remnant-uploads-prod
AWS_S3_PUBLIC_BASE_URL=
```

Keep `AWS_S3_PUBLIC_BASE_URL` empty while the bucket is private. The API returns
short-lived signed read URLs, so listing images remain available without making
the upload bucket public.

The Lambda execution role `remnant-lambda-role` needs write access to the upload
prefix:

```json
{
  "Effect": "Allow",
  "Action": [
    "s3:PutObject",
    "s3:GetObject",
    "s3:DeleteObject",
    "s3:GetObjectTagging",
    "s3:PutObjectTagging"
  ],
  "Resource": "arn:aws:s3:::remnant-uploads-prod/listings/*"
}
```

Uploads start with `remnant-status=temporary`, become `attached` after the
listing transaction commits, and become `orphaned` when replaced. Apply
`s3-listings-lifecycle.example.json` to expire unclaimed uploads after one day
and replaced images after seven days. The URL-to-key validation supports both
the bucket hostname and the configured CloudFront public base URL.
