# Remnant production runbook

This is the operational gate for the public, connection-only marketplace. A code build is not a production approval. Every unchecked item below remains a launch blocker.

## Ownership and targets

- Release owner: repository owner or named delegate with AWS, Supabase, Cognito, DNS, and GitHub production-environment access.
- Support owner: person monitoring the support queue and `support@remnantmarket.co` each day.
- Security contact: same owner until explicitly delegated.
- Target recovery point (RPO): no more than 24 hours of database data.
- Target recovery time (RTO): service restored or placed in a safe read-only state within four hours.
- Payments: absent. Do not enable transaction, order, Paystack, refund, or escrow routes or environment flags.

## Release gate

1. Confirm both repository workflows passed from clean `npm ci` installations.
2. Confirm production dependency audits report no high or critical findings.
3. Review the new migration. It must be additive or otherwise compatible with the currently running API. Never edit an applied migration.
4. Confirm the GitHub `production` environment requires an approval and contains only the required deployment secrets, including a confirmed monitored SNS topic in `ALARM_TOPIC_ARN`.
5. Confirm the latest backup timestamp and record it in the release ticket.
6. Confirm the support inbox/queue has an owner for launch day.
7. Approve backend first, wait for its smoke checks, then approve frontend.
8. Run `scripts/verify-production.ps1` from a machine with AWS CLI access.
9. Complete the authenticated and guest smoke matrix below.

## Backup and restore gate

Before public launch, open the Supabase project dashboard and record:

- plan and actual backup/PITR entitlement;
- most recent successful backup time;
- retention period;
- project/database identifier;
- person authorized to restore.

If provider retention cannot satisfy the 24-hour RPO, schedule an encrypted daily `pg_dump` to a private, versioned store with separate credentials. Do not put database exports in either repository or an unencrypted workstation folder.

At least once before launch, restore the latest backup or encrypted logical dump into a disposable PostgreSQL project. Run Prisma migration status, query counts for `User`, `Listing`, `Upload`, `Conversation`, and `Message`, open a listing with its image, then delete the disposable project. Record date, restore duration, source backup time, result, and operator. A dashboard screenshot showing that backups exist is not a restore test.

## Cognito gate

For the public web app client, verify all of the following in AWS:

- no client secret;
- authorization-code grant and PKCE;
- scopes `openid`, `email`, and `profile`;
- callback `https://remnantmarket.co/auth/callback`;
- logout URL `https://remnantmarket.co`;
- `ALLOW_USER_PASSWORD_AUTH` when the native email/password form is displayed;
- refresh-token revocation enabled;
- Lambda role permissions match any intentional admin fallback.

Use a designated production smoke account to test registration, verification, password login, refresh after access-token expiry, forgot/reset password, Google login, invalid OAuth state/nonce rejection, logout, and rejection of the old refresh session.

## Storage gate

- `remnant-uploads-prod` has all public-access blocks enabled and default server-side encryption.
- CORS permits only the production web origin and required upload methods/headers.
- The backend role is limited to the `listings/*` prefix.
- The S3 lifecycle rule must not delete `temporary` uploads independently of the database. Database `Upload` rows are authoritative; scheduled cleanup deletes unattached rows/objects after 24 hours.
- Test: upload succeeds then listing fails, cleanup removes the orphan; listing succeeds then S3 tagging fails, the active image remains; replacing/deleting an image schedules it for cleanup.

## Public smoke matrix

Authenticated seller:

- sign in and update both privacy flags;
- publish an image listing, retry the same request, and verify only one listing exists;
- pause, renew, complete, and delete only through allowed transitions;
- send, retry, read, and report a conversation;
- export data and submit account deletion only with a disposable account.

Guest seller, with no signup or contact capture:

- open `/sell-item`, supply only listing details and a display name;
- publish and save the private management link;
- refresh the management page, pause/relist/complete the listing, and open its inbox;
- reply to a buyer and report the conversation;
- verify another browser without the capability link receives no access;
- delete the guest identity and confirm its listings disappear.

Matching:

- verify exact and allowed near-size complements surface;
- verify same-side, incompatible size system/delta, wrong category/intent, self, same owner, paused, completed, expired, and deleted candidates never surface even with a high semantic score.

Privacy and abuse:

- from a second account and while signed out, verify private profiles return no personal projection and hidden city never appears;
- verify disallowed CORS origins receive controlled 403 responses, not 500;
- verify repeated auth, upload, guest listing, message, report, and support writes receive 429 responses;
- confirm reports and support requests appear in the admin queues and can be resolved.

## Monitoring and incident lookup

Every API response returns `X-Request-ID`; ask the reporter for it and the approximate time. Search CloudWatch logs for that ID. Logs must not include access tokens, refresh cookies, guest capability tokens, full message bodies, or uploaded file contents.

Create CloudWatch alarms for Lambda errors, throttles, duration near timeout, and API Gateway 5xx. Route alarms to a monitored email/SNS destination. Use the production verification script to confirm at least one alarm exists; tune thresholds after observing normal traffic.

Provision the baseline alarms after creating and confirming a monitored SNS subscription:

```powershell
npm run configure:alarms -- -NotificationTopicArn arn:aws:sns:us-east-1:ACCOUNT:TOPIC
```

Incident priorities:

- P0: personal-data exposure, capability/token leak, unauthorized access, destructive corruption. Disable affected writes or take the service offline, preserve logs, rotate exposed credentials, and notify affected users as required.
- P1: login, listing, upload, matching, or messaging unavailable for many users. Roll back code, keep incompatible schema changes forward-fixed, and post a status update.
- P2: isolated failure or degraded non-core route. Correlate by request ID, document workaround, and patch through CI.

## Rollback and recovery

Backend deployment downloads the current Lambda package before updating. If smoke checks fail, the workflow restores that package automatically. Database migrations are forward-only: deploy a new corrective migration; never rewrite or down-migrate production data without a tested restore plan.

For a frontend regression, redeploy the last known-good commit through the protected production environment. Verify `/`, `/marketplace`, `/sell-item`, `/login`, `/privacy`, and `/terms`, then purge/invalidate only if the hosting stack did not update cache keys automatically.

If the database is damaged, stop writes, record the incident time, choose the newest recovery point before it, restore to a disposable target first, validate it, then switch the application connection only after owner approval. Preserve the damaged database until the incident is closed.

## Scheduled maintenance

Run `npm run configure:schedules` once for each production AWS account. It creates one-minute matching/outbox rules and a daily maintenance rule targeting the API Lambda. The maintenance event expires listings, cleans orphan uploads, anonymizes deletion requests whose 30-day retention window elapsed, queues stale matches, and processes a bounded batch. Alert if scheduled invocations stop succeeding.

Review weekly during the first month:

- failed requests and 429 rate;
- unresolved reports/support requests;
- upload cleanup failures and storage growth;
- matching rejection/acceptance behavior;
- backup freshness;
- dependency alerts and failed CI jobs.
