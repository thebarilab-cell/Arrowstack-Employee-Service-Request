import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  validateConnectedDatabase,
  validateLocalStaffProvisionTarget,
} from '../src/cli/local-reset-target.js';
import {
  provisionStaffAccount,
  validateStaffProvisionInput,
} from '../src/cli/provision-staff-account.js';

describe('local staff account provisioning safeguards', () => {
  it('accepts only the configured local database outside production', () => {
    assert.equal(
      validateLocalStaffProvisionTarget('postgresql://operator:placeholder@localhost:5432/arrowstack_employee_service', 'development'),
      'arrowstack_employee_service',
    );
    for (const [url, environment] of [
      ['postgresql://operator:placeholder@db.example.test:5432/arrowstack_employee_service', 'development'],
      ['postgresql://operator:placeholder@localhost:5433/arrowstack_employee_service', 'development'],
      ['postgresql://operator:placeholder@localhost:5432/other_database', 'development'],
      ['postgresql://operator:placeholder@localhost:5432/arrowstack_employee_service', 'production'],
      ['postgresql://operator:placeholder@localhost:5432/arrowstack_employee_service', ' Production '],
    ]) {
      assert.throws(() => validateLocalStaffProvisionTarget(url, environment), /restricted to the local development database/);
    }
    assert.doesNotThrow(() => validateConnectedDatabase('arrowstack_employee_service', '127.0.0.1/32'));
    assert.throws(() => validateConnectedDatabase('arrowstack_employee_service', '192.168.1.20/32'));
    assert.throws(() => validateConnectedDatabase('another_database', '127.0.0.1/32'));
  });

  it('normalizes email and validates display name, password length, and confirmation', () => {
    assert.deepEqual(validateStaffProvisionInput({
      email: '  STAFF@Example.COM ', displayName: '  Service Operator  ',
      password: 'a-secure-password', confirmation: 'a-secure-password',
    }), { email: 'staff@example.com', displayName: 'Service Operator', password: 'a-secure-password' });

    for (const input of [
      { email: 'invalid', displayName: 'Staff', password: 'a-secure-password', confirmation: 'a-secure-password' },
      { email: 'staff@example.com', displayName: '  ', password: 'a-secure-password', confirmation: 'a-secure-password' },
      { email: 'staff@example.com', displayName: 'Staff', password: 'short', confirmation: 'short' },
      { email: 'staff@example.com', displayName: 'Staff', password: 'x'.repeat(73), confirmation: 'x'.repeat(73) },
      { email: 'staff@example.com', displayName: 'Staff', password: 'a-secure-password', confirmation: 'a-different-password' },
    ]) assert.throws(() => validateStaffProvisionInput(input));
  });

  it('creates a new staff account in one parameterized transaction', async () => {
    const calls = [];
    const client = { async query(sql, params = []) {
      calls.push({ sql: sql.trim(), params });
      if (sql.includes('SELECT id')) return { rows: [] };
      if (sql.includes('INSERT INTO public.users')) return { rows: [{ id: randomUUID() }] };
      return { rows: [] };
    } };
    const result = await provisionStaffAccount(client, {
      email: 'staff@example.com', displayName: 'Staff Member', passwordHash: '$2b$12$test-hash-value',
    });

    assert.ok(result.id);
    assert.equal(calls[0].sql, 'BEGIN');
    assert.deepEqual(calls[1].params, ['staff@example.com']);
    assert.match(calls[2].sql, /VALUES \(\$1, \$2, 'staff', \$3\)/);
    assert.deepEqual(calls[2].params, ['staff@example.com', 'Staff Member', '$2b$12$test-hash-value']);
    assert.equal(calls.at(-1).sql, 'COMMIT');
    assert.equal(calls.some(({ sql }) => /UPDATE public\.(users|auth_sessions)/i.test(sql)), false);
  });

  it('rejects duplicate employee and staff accounts without changing roles or sessions', async () => {
    for (const role of ['employee', 'staff']) {
      const calls = [];
      const client = { async query(sql, params = []) {
        calls.push({ sql: sql.trim(), params });
        if (sql.includes('SELECT id')) return { rows: [{ id: randomUUID(), role }] };
        return { rows: [] };
      } };
      await assert.rejects(
        provisionStaffAccount(client, { email: 'existing@example.com', displayName: 'Existing User', passwordHash: 'test-hash' }),
        { code: 'STAFF_ACCOUNT_EXISTS', message: 'An account with that email already exists. No role was changed.' },
      );
      assert.equal(calls.at(-1).sql, 'ROLLBACK');
      assert.equal(calls.some(({ sql }) => /INSERT INTO public\.users/i.test(sql)), false);
      assert.equal(calls.some(({ sql }) => /UPDATE public\.(users|auth_sessions)/i.test(sql)), false);
    }
  });

  it('rolls back if a concurrent account insert wins the unique-email race', async () => {
    const calls = [];
    const client = { async query(sql) {
      calls.push(sql.trim());
      if (sql.includes('SELECT id')) return { rows: [] };
      if (sql.includes('INSERT INTO public.users')) {
        const error = new Error('duplicate');
        error.code = '23505';
        throw error;
      }
      return { rows: [] };
    } };
    await assert.rejects(
      provisionStaffAccount(client, { email: 'race@example.com', displayName: 'Race', passwordHash: 'test-hash' }),
      { code: 'STAFF_ACCOUNT_EXISTS' },
    );
    assert.equal(calls.at(-1), 'ROLLBACK');
  });
});
