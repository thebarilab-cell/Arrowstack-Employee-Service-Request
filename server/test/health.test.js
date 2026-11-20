import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { validateRuntimeConfig } from '../src/runtime-config.js';

describe('GET /api/health', () => {
  const server = createApp().listen(0);
  const address = server.address();

  after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  it('returns an API health status', async () => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', service: 'employee-service-api' });
  });
});

describe('GET /api/ready', () => {
  it('reports ready when PostgreSQL and the required schema relations exist', async (t) => {
    const pool = { async query(_sql, [relations]) {
      return { rows: relations.map((relation_name) => ({ relation_name, available: true })) };
    } };
    const server = createApp({ pool }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ready`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ready', service: 'employee-service-api' });
  });

  it('returns a safe 503 when PostgreSQL or the required schema is unavailable', async (t) => {
    for (const pool of [
      { async query() { throw new Error('private database error'); } },
      { async query(_sql, [relations]) { return { rows: relations.map((relation_name, index) => ({ relation_name, available: index !== 2 })) }; } },
    ]) {
      const server = createApp({ pool }).listen(0);
      await new Promise((resolve) => server.once('listening', resolve));
      t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ready`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: { code: 'DATABASE_NOT_READY', message: 'Database connection or required schema is not ready.' },
      });
    }
  });
});

describe('production runtime configuration', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://app:placeholder@db.example.test:5432/arrowstack_employee_service?sslmode=verify-full',
    JWT_SECRET: 'private-production-signing-key-at-least-32-bytes',
  };

  it('accepts valid production settings and defaults to port 3000', () => {
    assert.deepEqual(validateRuntimeConfig(base), { port: 3000 });
    assert.deepEqual(validateRuntimeConfig({ ...base, PORT: '8443' }), { port: 8443 });
  });

  it('rejects missing production secrets, invalid database URLs, and invalid ports without echoing values', () => {
    for (const environment of [
      { ...base, DATABASE_URL: '' },
      { ...base, DATABASE_URL: 'not-a-url' },
      { ...base, DATABASE_URL: 'postgresql:///arrowstack_employee_service?sslmode=verify-full' },
      { ...base, DATABASE_URL: base.DATABASE_URL.replace('sslmode=verify-full', 'sslmode=require') },
      { ...base, JWT_SECRET: '<placeholder>' },
      { ...base, JWT_SECRET: 'too-short' },
      { ...base, PORT: '70000' },
      { ...base, PORT: '3000;echo secret' },
    ]) assert.throws(() => validateRuntimeConfig(environment));
  });
});
