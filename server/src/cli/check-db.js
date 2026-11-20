import '../load-env.js';
import { createPool } from '../db.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is empty. Set it in the project root .env file, then retry.');
  process.exit(1);
}

const pool = createPool();

try {
  const { rows: [database] } = await pool.query(
    'SELECT current_database() AS name, current_setting(\'server_version\') AS version',
  );

  if (database.name !== 'arrowstack_employee_service') {
    throw new Error('The configured connection points to a different database.');
  }

  console.log(`Connection verified: ${database.name} on PostgreSQL ${database.version}.`);
} catch {
  console.error('Database connection check failed. Credentials and connection details were not displayed.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
