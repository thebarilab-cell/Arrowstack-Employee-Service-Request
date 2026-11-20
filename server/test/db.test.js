import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/db.js';

describe('PostgreSQL configuration', () => {
  it('requires a connection string and never supplies a default credential', () => {
    assert.throws(() => createPool(''), /DATABASE_URL must be set/);
    const pool = createPool('postgresql://user:placeholder@localhost/database');
    assert.equal(pool.options.connectionString, 'postgresql://user:placeholder@localhost/database');
    return pool.end();
  });
});
