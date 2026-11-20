import '../load-env.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPool } from '../db.js';

const pool = createPool();
const seedPath = fileURLToPath(new URL('../../seeds/categories.sql', import.meta.url));

try {
  const sql = await readFile(seedPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  console.log('Service category seed data applied (existing categories were left unchanged).');
} catch {
  console.error('Database seed failed. Error details were suppressed to protect connection credentials.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
