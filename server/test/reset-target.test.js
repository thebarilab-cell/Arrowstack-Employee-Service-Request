import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateConnectedDatabase, validateLocalResetTarget } from '../src/cli/local-reset-target.js';

describe('employee password reset database target guard', () => {
  it('accepts the expected local database on PostgreSQL port 5432', () => {
    assert.equal(
      validateLocalResetTarget('postgresql://local_user:placeholder@localhost:5432/arrowstack_employee_service', 'development'),
      'arrowstack_employee_service',
    );
  });

  it('rejects remote hosts, other databases, alternate ports, query overrides, invalid URLs, and production mode', () => {
    const invalidTargets = [
      ['postgresql://local_user:placeholder@db.example.test:5432/arrowstack_employee_service', 'development'],
      ['postgresql://local_user:placeholder@localhost:5432/another_database', 'development'],
      ['postgresql://local_user:placeholder@localhost:5433/arrowstack_employee_service', 'development'],
      ['postgresql://local_user:placeholder@localhost:5432/arrowstack_employee_service?host=db.example.test', 'development'],
      ['not-a-database-url', 'development'],
      ['postgresql://local_user:placeholder@localhost:5432/arrowstack_employee_service', 'production'],
    ];

    for (const [connectionString, environment] of invalidTargets) {
      assert.throws(
        () => validateLocalResetTarget(connectionString, environment),
        { message: 'Password reset is restricted to the local development database.' },
      );
    }
  });

  it('requires the connected PostgreSQL server itself to report the expected database and a loopback address', () => {
    assert.doesNotThrow(() => validateConnectedDatabase('arrowstack_employee_service', '127.0.0.1'));
    assert.doesNotThrow(() => validateConnectedDatabase('arrowstack_employee_service', '::1'));
    assert.doesNotThrow(() => validateConnectedDatabase('arrowstack_employee_service', '127.0.0.1/32'));
    assert.doesNotThrow(() => validateConnectedDatabase('arrowstack_employee_service', '::1/128'));
    assert.throws(
      () => validateConnectedDatabase('arrowstack_employee_service', '10.0.0.8'),
      { message: 'Connected PostgreSQL server is not the expected local development database.' },
    );
    for (const address of ['10.0.0.8/32', '127.0.0.1/24', '::2/128', '127.999.0.1']) {
      assert.throws(
        () => validateConnectedDatabase('arrowstack_employee_service', address),
        { message: 'Connected PostgreSQL server is not the expected local development database.' },
      );
    }
    assert.throws(
      () => validateConnectedDatabase('production_database', '127.0.0.1'),
      { message: 'Connected PostgreSQL server is not the expected local development database.' },
    );
  });
});
