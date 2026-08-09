# Remnant API

NestJS API for Remnant, a connection-only marketplace for finding compatible item halves and parts. Remnant does not process payments or provide escrow.

## Local setup

1. Copy `.env.example` to `.env` and supply development values.
2. Install dependencies with `npm ci`.
3. Generate the Prisma client with `npm run db:generate`.
4. Start the API with `npm run start:dev`.

Do not commit `.env`, `lambda-env.production.json`, tokens, or database credentials.

## Verification

Run the same release gates used by CI:

```powershell
npm run audit:prod
npm run verify
```

`verify` generates Prisma, lints without modifying files, type-checks, runs all tests, and creates the production build.

## Database changes

Create a new migration for every schema change. Never edit an applied migration. Production deployment validates the SHA-256 checksum of every applied migration and stops if committed SQL no longer matches the database record.

```powershell
npm run db:generate
npm run db:deploy:pooler
```

## Runtime

- Local entry: `src/main.ts`
- API Gateway/Lambda entry: `src/lambda.ts`
- Scheduled maintenance entry: `src/backfill.handler.ts`
- Database: Supabase PostgreSQL through its pooler
- Identity: Amazon Cognito
- Listing images: private Amazon S3 objects with signed reads

The scheduled maintenance handler processes matching jobs, expires stale listings, removes unattached uploads, and completes retained deletion requests.

## Operations

Deployment and environment details are in `BACKEND_LAUNCH_SETUP.md`. The complete launch, rollback, recovery, and incident procedure is in `PRODUCTION_RUNBOOK.md`.
