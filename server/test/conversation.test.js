import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';

const jwtSecret = 'conversation-test-signing-key-with-at-least-32-bytes';

function makePool({ failActivityLog = false } = {}) {
  const users = [
    { id: randomUUID(), display_name: 'Employee One', role: 'employee', is_active: true },
    { id: randomUUID(), display_name: 'Employee Two', role: 'employee', is_active: true },
    { id: randomUUID(), display_name: 'Staff One', role: 'staff', is_active: true },
  ];
  const requestRows = [
    { id: randomUUID(), requester_id: users[0].id },
    { id: randomUUID(), requester_id: users[1].id },
  ];
  const sessions = new Map();
  const comments = [];
  const activity = [];

  async function query(sql, params = [], tx) {
    if (/^BEGIN$/i.test(sql.trim())) return { rows: [] };
    if (/^ROLLBACK$/i.test(sql.trim())) {
      if (tx) { tx.comments.length = 0; tx.activity.length = 0; }
      return { rows: [] };
    }
    if (/^COMMIT$/i.test(sql.trim())) {
      if (tx) { comments.push(...tx.comments); activity.push(...tx.activity); }
      return { rows: [] };
    }
    if (/FROM public\.auth_sessions AS s/i.test(sql)) {
      const [tokenId, userId] = params;
      const session = sessions.get(tokenId);
      const user = users.find((row) => row.id === userId);
      return session?.userId === userId && user?.is_active
        ? { rows: [{ id: user.id, email: `${user.display_name.toLowerCase().replaceAll(' ', '.')}@example.test`, display_name: user.display_name, role: user.role, created_at: new Date() }] }
        : { rows: [] };
    }
    if (/SELECT r\.id FROM public\.service_requests AS r WHERE r\.id = \$1/i.test(sql)) {
      const [id, userId] = params;
      const row = requestRows.find((item) => item.id === id && (sql.includes('requester_id = $2') ? item.requester_id === userId : true));
      return { rows: row ? [{ id: row.id }] : [] };
    }
    if (/SELECT c\.id, c\.body, c\.is_internal/i.test(sql)) {
      const [requestId, includeInternal] = params;
      return { rows: comments.filter((item) => item.request_id === requestId && (includeInternal || !item.is_internal))
        .map((item) => ({ ...item, author_id: item.author_id, author_name: users.find((u) => u.id === item.author_id).display_name, author_role: users.find((u) => u.id === item.author_id).role })) };
    }
    if (/SELECT l\.id, l\.action, l\.details/i.test(sql)) {
      const [requestId] = params;
      return { rows: activity.filter((item) => item.request_id === requestId).map((item) => {
        const actor = users.find((u) => u.id === item.actor_id);
        return { ...item, actor_id: actor?.id ?? null, actor_name: actor?.display_name ?? null, actor_role: actor?.role ?? null };
      }) };
    }
    if (/INSERT INTO public\.request_comments/i.test(sql)) {
      const [requestId, userId, authorId, body] = params;
      const requestRow = requestRows.find((row) => row.id === requestId && (sql.includes('requester_id = $2') ? row.requester_id === userId : true));
      if (!requestRow) return { rows: [] };
      const comment = { id: randomUUID(), request_id: requestId, author_id: authorId, body, is_internal: false, created_at: new Date() };
      tx.comments.push(comment);
      return { rows: [comment] };
    }
    if (/INSERT INTO public\.request_activity_logs/i.test(sql)) {
      if (failActivityLog) throw new Error('Simulated activity log failure');
      const [requestId, actorId, action, details] = params;
      tx.activity.push({ id: randomUUID(), request_id: requestId, actor_id: actorId, action, details: JSON.parse(details), created_at: new Date() });
      return { rows: [] };
    }
    throw new Error(`Unexpected conversation test query: ${sql}`);
  }

  return {
    users, requestRows, sessions, comments, activity,
    async query(...args) { return query(...args); },
    async connect() {
      const tx = { comments: [], activity: [] };
      return { query: (sql, params) => query(sql, params, tx), release() {} };
    },
  };
}

function tokenFor(pool, user) {
  const tokenId = randomUUID();
  pool.sessions.set(tokenId, { userId: user.id });
  return jwt.sign({}, jwtSecret, {
    algorithm: 'HS256', audience: 'arrowstack-client', expiresIn: 3600,
    issuer: 'arrowstack-employee-service', jwtid: tokenId, subject: user.id,
  });
}

async function setup(t, options) {
  const pool = makePool(options);
  const employeeToken = tokenFor(pool, pool.users[0]);
  const otherEmployeeToken = tokenFor(pool, pool.users[1]);
  const staffToken = tokenFor(pool, pool.users[2]);
  const server = createApp({ pool, jwtSecret }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return { pool, employeeToken, otherEmployeeToken, staffToken, base: `http://127.0.0.1:${server.address().port}` };
}

function headers(token) { return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }; }

describe('request comments and activity API', () => {
  it('allows employees to comment on owned requests and read activity, while hiding internal comments', async (t) => {
    const { pool, base, employeeToken } = await setup(t);
    const id = pool.requestRows[0].id;
    const response = await fetch(`${base}/api/requests/${id}/comments`, {
      method: 'POST', headers: headers(employeeToken), body: JSON.stringify({ body: '  I can provide more details.  ' }),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).comment.body, 'I can provide more details.');
    assert.equal(pool.comments.length, 1);
    assert.equal(pool.activity[0].action, 'comment_added');
    pool.comments.push({ id: randomUUID(), request_id: id, author_id: pool.users[2].id, body: 'Staff note', is_internal: true, created_at: new Date() });
    const listed = await fetch(`${base}/api/requests/${id}/comments`, { headers: headers(employeeToken) });
    const listedBody = await listed.json();
    assert.equal(listed.status, 200);
    assert.equal(listedBody.comments.length, 1);
    const history = await fetch(`${base}/api/requests/${id}/activity`, { headers: headers(employeeToken) });
    assert.equal((await history.json()).activity[0].action, 'comment_added');
  });

  it('denies unauthenticated and cross-employee reads/writes', async (t) => {
    const { pool, base, employeeToken, otherEmployeeToken } = await setup(t);
    const id = pool.requestRows[0].id;
    for (const suffix of ['comments', 'activity']) {
      assert.equal((await fetch(`${base}/api/requests/${id}/${suffix}`)).status, 401);
    }
    assert.equal((await fetch(`${base}/api/staff/requests/${id}/comments`, { headers: headers(employeeToken) })).status, 403);
    for (const suffix of ['comments', 'activity']) {
      const response = await fetch(`${base}/api/requests/${id}/${suffix}`, { headers: headers(otherEmployeeToken) });
      assert.equal(response.status, 404);
    }
    const post = await fetch(`${base}/api/requests/${id}/comments`, {
      method: 'POST', headers: headers(otherEmployeeToken), body: JSON.stringify({ body: 'Unauthorized comment' }),
    });
    assert.equal(post.status, 404);
    assert.equal(pool.comments.length, 0);
    assert.equal(employeeToken.length > 0, true);
  });

  it('validates comment body and rolls back comment insertion when activity logging fails', async (t) => {
    const { pool, base, employeeToken } = await setup(t, { failActivityLog: true });
    const id = pool.requestRows[0].id;
    for (const body of [{ body: '  ' }, { body: 'x'.repeat(5001) }, { body: 'Valid', isInternal: true }]) {
      const response = await fetch(`${base}/api/requests/${id}/comments`, {
        method: 'POST', headers: headers(employeeToken), body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
    const failed = await fetch(`${base}/api/requests/${id}/comments`, {
      method: 'POST', headers: headers(employeeToken), body: JSON.stringify({ body: 'Valid comment' }),
    });
    assert.equal(failed.status, 500);
    assert.equal(pool.comments.length, 0);
    assert.equal(pool.activity.length, 0);
  });

  it('allows staff to comment and view request activity and internal comments', async (t) => {
    const { pool, base, staffToken } = await setup(t);
    const id = pool.requestRows[0].id;
    pool.comments.push({ id: randomUUID(), request_id: id, author_id: pool.users[2].id, body: 'Private note', is_internal: true, created_at: new Date() });
    const listed = await fetch(`${base}/api/staff/requests/${id}/comments`, { headers: headers(staffToken) });
    assert.equal((await listed.json()).comments[0].isInternal, true);
    const added = await fetch(`${base}/api/staff/requests/${id}/comments`, {
      method: 'POST', headers: headers(staffToken), body: JSON.stringify({ body: 'Update from staff' }),
    });
    assert.equal(added.status, 201);
    const history = await fetch(`${base}/api/staff/requests/${id}/activity`, { headers: headers(staffToken) });
    assert.equal((await history.json()).activity[0].action, 'comment_added');
  });
});
