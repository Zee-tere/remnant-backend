const { createHash, randomUUID } = require('node:crypto');
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');

require('dotenv').config({ quiet: true });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const migrationsDirectory = join(__dirname, '..', 'prisma', 'migrations');
const migrationNames = readdirSync(migrationsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(migrationsDirectory, entry.name, 'migration.sql')))
  .map((entry) => entry.name)
  .sort();

const client = new Client({ connectionString });

async function main() {
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      id VARCHAR(36) PRIMARY KEY,
      checksum VARCHAR(64) NOT NULL,
      finished_at TIMESTAMPTZ,
      migration_name VARCHAR(255) NOT NULL,
      logs TEXT,
      rolled_back_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      applied_steps_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  await client.query('SELECT pg_advisory_lock($1)', [72707369]);

  const result = await client.query(
    'SELECT migration_name, checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
  );
  const applied = new Map(result.rows.map((row) => [row.migration_name, row.checksum]));

  for (const migrationName of migrationNames) {
    const sql = readFileSync(join(migrationsDirectory, migrationName, 'migration.sql'), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (applied.has(migrationName)) {
      if (applied.get(migrationName) !== checksum) {
        throw new Error(
          `Migration ${migrationName} was changed after it was applied. Restore the committed SQL; create a new forward migration instead.`,
        );
      }
      continue;
    }

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        `INSERT INTO "_prisma_migrations"
          (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
         VALUES ($1, $2, NOW(), $3, NULL, NULL, NOW(), 1)`,
        [randomUUID(), checksum, migrationName],
      );
      await client.query('COMMIT');
      console.log(`Applied migration ${migrationName}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  console.log(`Database is up to date (${migrationNames.length} migrations).`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.query('SELECT pg_advisory_unlock($1)', [72707369]).catch(() => undefined);
    await client.end().catch(() => undefined);
  });
