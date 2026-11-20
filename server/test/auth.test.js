import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';

function createMemoryPool() {
  const users = new Map();
  const usersById = new Map();
  const sessions = new Map();

  async function query(sql, params = []) {
    if (/INSERT INTO public\.users/i.test(sql)) {
      const [email, displayName, passwordHash] = params;
      if (users.has(email)) throw Object.assign(new Error('duplicate'), { code: '23505' });
      const user = {
        id: randomUUID(), email, display_name: displayName, role: 'employee',
        is_active: true, password_hash: passwordHash, created_at: new Date(),
      };
      users.set(email, user);
      usersById.set(user.id, user);
      return { rows: [{ id: user.id, email, display_name: displayName, role: user.role, created_at: user.created_at }] };
    }
    if (/INSERT INTO public\.auth_sessions/i.test(sql)) {
      const [tokenId, userId, expiresAt] = params;
      sessions.set(tokenId, { token_id: tokenId, user_id: userId, expires_at: expiresAt, revoked_at: null });
      return { rows: [] };
    }
    if (/SELECT id, email, display_name, role, is_active, password_hash/i.test(sql)) {
      const user = users.get(params[0]);
      return { rows: user ? [user] : [] };
    }
    if (/SELECT u\.id, u\.email, u\.display_name, u\.role, u\.created_at/i.test(sql)) {
      const [tokenId, userId] = params;
      const session = sessions.get(tokenId);
      const user = usersById.get(userId);
      if (!session || session.user_id !== userId || session.revoked_at || session.expires_at <= new Date() || !user?.is_active) {
        return { rows: [] };
      }
      return { rows: [{ id: user.id, email: user.email, display_name: user.display_name, role: user.role, created_at: user.created_at }] };
    }
    if (/UPDATE public\.auth_sessions/i.test(sql)) {
      const session = sessions.get(params[0]);
      if (session && !session.revoked_at) session.revoked_at = new Date();
      return { rows: [] };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return { rows: [] };
    throw new Error(`Unexpected test query: ${sql}`);
  }

  return {
    users,
    async query(...args) { return query(...args); },
    async connect() {
      return { query, release() {} };
    },
  };
}

async function startTestServer(t, jwtSecret = 'test-only-signing-secret-that-is-at-least-32-bytes') {
  const pool = createMemoryPool();
  const server = createApp({ pool, jwtSecret, passwordRounds: 4 }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return { pool, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function register(baseUrl, email = 'Person@example.com') {
  return fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'a-very-secure-test-password', displayName: 'Test Person' }),
  });
}

describe('authentication API', () => {
  it('rejects placeholder signing keys without attempting authentication', async (t) => {
    const { baseUrl } = await startTestServer(t, '<generate-a-secret-here-that-is-long-enough>');
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.com', password: 'a-very-secure-test-password', displayName: 'Test Person' }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'AUTH_NOT_CONFIGURED');
  });

  it('registers and logs in with normalized email without returning password hashes', async (t) => {
    const { baseUrl, pool } = await startTestServer(t);
    const registration = await register(baseUrl, '  Person@Example.COM  ');
    const registered = await registration.json();

    assert.equal(registration.status, 201);
    assert.equal(registered.user.email, 'person@example.com');
    assert.equal(registered.user.role, 'employee');
    assert.equal('password_hash' in registered.user, false);
    assert.equal('passwordHash' in registered.user, false);
    assert.equal('password_hash' in registered, false);
    assert.equal(await bcrypt.compare('a-very-secure-test-password', pool.users.get('person@example.com').password_hash), true);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'PERSON@example.com', password: 'a-very-secure-test-password' }),
    });
    const loggedIn = await login.json();
    assert.equal(login.status, 200);
    assert.equal(loggedIn.user.id, registered.user.id);
    assert.equal(loggedIn.tokenType, 'Bearer');
    assert.equal('password_hash' in loggedIn, false);
    assert.ok(loggedIn.token);
  });

  it('returns the same safe invalid-credentials response for unknown email and wrong password', async (t) => {
    const { baseUrl } = await startTestServer(t);
    await register(baseUrl);

    async function login(email, password) {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      return { status: response.status, body: await response.json() };
    }

    const wrongPassword = await login('person@example.com', 'incorrect-password-value');
    const unknownEmail = await login('missing@example.com', 'incorrect-password-value');
    assert.equal(wrongPassword.status, 401);
    assert.deepEqual(unknownEmail, wrongPassword);
    assert.deepEqual(wrongPassword.body.error, {
      code: 'INVALID_CREDENTIALS',
      message: 'Email or password is incorrect.',
    });
  });

  it('rejects duplicate email addresses case-insensitively', async (t) => {
    const { baseUrl } = await startTestServer(t);
    assert.equal((await register(baseUrl, 'person@example.com')).status, 201);
    const duplicate = await register(baseUrl, 'PERSON@example.com');
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error.code, 'EMAIL_ALREADY_REGISTERED');
  });

  it('validates registration fields and reports JSON errors consistently', async (t) => {
    const { baseUrl } = await startTestServer(t);
    const invalid = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'short', displayName: '' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'INVALID_INPUT');

    const malformed = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid json',
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual((await malformed.json()).error, {
      code: 'INVALID_JSON',
      message: 'Request body must be valid JSON.',
    });
  });

  it('protects /me and revokes a token on logout', async (t) => {
    const { baseUrl } = await startTestServer(t);
    const response = await register(baseUrl);
    const { token } = await response.json();

    const unauthorized = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(unauthorized.status, 401);

    const headers = { authorization: `Bearer ${token}` };
    const me = await fetch(`${baseUrl}/api/auth/me`, { headers });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.email, 'person@example.com');

    const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers });
    assert.equal(logout.status, 204);
    const afterLogout = await fetch(`${baseUrl}/api/auth/me`, { headers });
    assert.equal(afterLogout.status, 401);
  });
});
