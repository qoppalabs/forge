import { readdir } from "node:fs/promises";
import path from "node:path";

import { SQL } from "bun";

export type Db = SQL;

export function connect(url: string): Db {
  return new SQL(url, { max: 10 });
}

const MIGRATIONS = path.join(import.meta.dir, "..", "migrations");

/** Serialises migrations across processes (the API and worker may start together). */
const MIGRATION_LOCK = 7_291_002;

/** Applies pending `migrations/*.sql` files in order, each in its own transaction. */
export async function migrate(db: Db): Promise<string[]> {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
  });
  const entries = await readdir(MIGRATIONS);
  const files = entries.filter((f) => f.endsWith(".sql")).toSorted();
  const ran: string[] = [];
  for (const file of files) {
    // oxlint-disable-next-line no-await-in-loop -- migrations apply one at a time, in filename order
    const text = await Bun.file(path.join(MIGRATIONS, file)).text();
    // oxlint-disable-next-line no-await-in-loop -- each migration commits before the next one is read
    const applied = await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`;
      const [done] =
        await tx`SELECT 1 FROM schema_migrations WHERE version = ${file}`;
      if (done) {
        return false;
      }
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migrations (version) VALUES (${file})`;
      return true;
    });
    if (applied) {
      ran.push(file);
    }
  }
  return ran;
}

/** Drops and recreates the public schema. Test databases only. */
export async function resetDatabase(db: Db): Promise<void> {
  const [{ name }] = await db`SELECT current_database() AS name`;
  if (!String(name).endsWith("_test")) {
    throw new Error(`Refusing to reset non-test database ${name}`);
  }
  await db.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
}

export function isUniqueViolation(error: unknown): boolean {
  return (error as { errno?: string })?.errno === "23505";
}
