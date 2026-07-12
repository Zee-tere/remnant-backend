# Remnant Backend Launch Setup

This backend is now aligned with the zero-cost launch architecture from the rewrite brief:

- NestJS REST API packaged for AWS Lambda.
- API Gateway HTTP API in front of `dist/lambda.handler`.
- Supabase PostgreSQL as the database runtime.
- Supabase Realtime for notifications, matches, transactions, and messages.
- Cognito Hosted UI for email/password and Google auth.
- Cognito access-token verification in NestJS via `aws-jwt-verify`.
- OpenAI `text-embedding-3-small` embeddings stored in Supabase `pgvector`.
- EventBridge-triggered match backfill via `dist/backfill.handler.handler`.
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

Listing create/update stores an OpenAI embedding when `OPENAI_API_KEY` is configured, then runs matching.

Search endpoint:

```http
GET /listings/search?q=left%20airpod&category=electronics&city=Lagos&intent=WANTED
```

If OpenAI is not configured in local development, matching falls back to the previous token similarity behavior so developers can still run the app.

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
```

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
AWS_S3_PUBLIC_BASE_URL=https://remnant-uploads-prod.s3.us-east-1.amazonaws.com
```

The Lambda execution role `remnant-lambda-role` needs write access to the upload
prefix:

```json
{
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
  "Resource": "arn:aws:s3:::remnant-uploads-prod/listings/*"
}
```
