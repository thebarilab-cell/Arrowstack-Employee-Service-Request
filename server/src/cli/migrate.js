import '../load-env.js';
import { createPool } from '../db.js';
import { runMigrations } from '../migrate.js';

const pool = createPool();

try {
  const applied = await runMigrations(pool);
  if (applied.length === 0) {
    console.log('Database schema is already up to date.');
  } else {
    console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
  }
} catch {
  console.error('Database migration failed. Error details were suppressed to protect connection credentials.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
