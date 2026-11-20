import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runMigrations } from '../src/migrate.js';

describe('migration runner', () => {
  let directory;

  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'arrowstack-migrations-'));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, '002_second.sql'), 'SELECT 2;');
    await writeFile(path.join(directory, '001_first.sql'), 'SELECT 1;');
    await writeFile(path.join(directory, 'notes.txt'), 'ignored');
  });

  after(async () => rm(directory, { recursive: true, force: true }));

  it('applies numbered migrations in order and records them atomically', async () => {
    const applied = new Map();
    const calls = [];
    const client = {
      async query(sql, params = []) {
        calls.push(sql.trim());
        if (sql.includes('SELECT checksum')) {
          return { rows: applied.has(params[0]) ? [{ checksum: applied.get(params[0]) }] : [] };
        }
        if (sql.includes('INSERT INTO public.schema_migrations')) {
          applied.set(params[0], params[1]);
        }
        return { rows: [] };
      },
      release() { calls.push('RELEASE'); },
    };
    const pool = { async connect() { return client; } };

    assert.deepEqual(await runMigrations(pool, directory), ['001_first.sql', '002_second.sql']);
    assert.equal(calls.indexOf('SELECT 1;') < calls.indexOf('SELECT 2;'), true);
    assert.equal(calls.filter((sql) => sql === 'COMMIT').length, 2);
    assert.equal(calls.at(-2).startsWith('SELECT pg_advisory_unlock'), true);
    assert.equal(calls.at(-1), 'RELEASE');

    const callCount = calls.length;
    assert.deepEqual(await runMigrations(pool, directory), []);
    assert.equal(calls.filter((sql) => sql === 'BEGIN').length, 2);
    assert.ok(calls.length > callCount);
  });

  it('rejects edits to migrations that have already been applied', async () => {
    const applied = new Map([['001_first.sql', createHash('sha256').update('changed').digest('hex')]]);
    const client = {
      async query(sql, params = []) {
        if (sql.includes('SELECT checksum')) {
          return { rows: applied.has(params[0]) ? [{ checksum: applied.get(params[0]) }] : [] };
        }
        return { rows: [] };
      },
      release() {},
    };

    await assert.rejects(
      runMigrations({ async connect() { return client; } }, directory),
      /Applied migration 001_first\.sql has changed/,
    );
  });
});

describe('initial schema migration', () => {
  it('declares the required entities, references, constraints, and lookup indexes', async () => {
    const schema = await (await import('node:fs/promises')).readFile(
      new URL('../migrations/001_initial_schema.sql', import.meta.url),
      'utf8',
    );

    for (const table of ['users', 'service_categories', 'service_requests', 'request_comments', 'request_activity_logs']) {
      assert.match(schema, new RegExp(`CREATE TABLE public\\.${table}\\s*\\(`));
    }
    assert.match(schema, /DEFAULT gen_random_uuid\(\)/);
    assert.match(schema, /REFERENCES public\.users\(id\)/);
    assert.match(schema, /REFERENCES public\.service_categories\(id\)/);
    assert.match(schema, /priority IN \('low', 'medium', 'high', 'urgent'\)/);
    assert.match(schema, /status IN \('submitted', 'in_progress', 'waiting_on_employee', 'resolved', 'closed'\)/);
    assert.match(schema, /CREATE TRIGGER service_requests_assigned_staff/);
    assert.match(schema, /CREATE TRIGGER users_preserve_assigned_staff_role/);
    assert.match(schema, /service_requests_assignee_status_idx/);
    assert.match(schema, /request_activity_logs_request_created_idx/);
  });

  it('adds password storage and revocable JWT session persistence in a forward migration', async () => {
    const schema = await (await import('node:fs/promises')).readFile(
      new URL('../migrations/002_authentication.sql', import.meta.url),
      'utf8',
    );

    assert.match(schema, /ALTER TABLE public\.users\s+ADD COLUMN password_hash text/);
    assert.match(schema, /users_email_case_insensitive_idx/);
    assert.match(schema, /CREATE TABLE public\.auth_sessions/);
    assert.match(schema, /REFERENCES public\.users\(id\) ON DELETE CASCADE/);
    assert.match(schema, /revoked_at timestamptz/);
  });
});
