import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultMigrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const LOCK_CLASS_ID = 617;
const LOCK_OBJECT_ID = 2401;

export async function runMigrations(pool, migrationsDirectory = defaultMigrationsDirectory) {
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [LOCK_CLASS_ID, LOCK_OBJECT_ID]);
    lockAcquired = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const names = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
      .sort();
    const applied = [];

    for (const name of names) {
      const sql = await readFile(path.join(migrationsDirectory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const result = await client.query(
        'SELECT checksum FROM public.schema_migrations WHERE name = $1',
        [name],
      );

      if (result.rows.length > 0) {
        if (result.rows[0].checksum !== checksum) {
          throw new Error(`Applied migration ${name} has changed; create a new migration instead.`);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)',
          [name, checksum],
        );
        await client.query('COMMIT');
        applied.push(name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    return applied;
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_CLASS_ID, LOCK_OBJECT_ID]);
      } finally {
        client.release();
      }
    } else {
      client.release();
    }
  }
}
