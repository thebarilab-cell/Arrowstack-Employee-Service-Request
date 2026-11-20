import '../load-env.js';
import { createPool } from '../db.js';

const expectedTables = [
  'users',
  'service_requests',
  'request_comments',
  'request_activity_logs',
  'service_categories',
  'auth_sessions',
];
const expectedCategories = ['it', 'hr', 'facilities'];
const pool = createPool();

try {
  const { rows: tableRows } = await pool.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name = ANY($1::text[])
      ORDER BY table_name`,
    [expectedTables],
  );
  const foundTables = new Set(tableRows.map(({ table_name }) => table_name));
  const missingTables = expectedTables.filter((table) => !foundTables.has(table));

  const { rows: categories } = await pool.query(
    `SELECT slug, name
       FROM public.service_categories
      WHERE slug = ANY($1::text[])
      ORDER BY slug`,
    [expectedCategories],
  );
  const foundCategories = new Map(categories.map(({ slug, name }) => [slug, name]));
  const missingCategories = expectedCategories.filter((slug) => !foundCategories.has(slug));

  if (missingTables.length || missingCategories.length) {
    if (missingTables.length) console.error(`Missing tables: ${missingTables.join(', ')}`);
    if (missingCategories.length) console.error(`Missing category slugs: ${missingCategories.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`Verified tables: ${expectedTables.join(', ')}`);
    console.log(`Verified categories: ${expectedCategories.map((slug) => foundCategories.get(slug)).join(', ')}`);
  }
} catch {
  console.error('Database verification failed. Error details were suppressed to protect connection credentials.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
