import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';

const jwtSecret = 'staff-test-signing-key-that-is-at-least-32-bytes-long';
const jwtIssuer = 'arrowstack-employee-service';
const jwtAudience = 'arrowstack-client';

function createStaffTestPool({ failActivityLog = false } = {}) {
  const users = new Map();
  const sessions = new Map();
  const categories = [{ id: randomUUID(), slug: 'it', name: 'IT' }];
  const requests = [];
  const activityLogs = [];

  const employee = addUser('employee', 'employee@example.test');
  const staff = addUser('staff', 'staff@example.test');
  const secondStaff = addUser('staff', 'second.staff@example.test');
  const inactiveStaff = addUser('staff', 'inactive.staff@example.test', false);

  function addUser(role, email, isActive = true) {
    const user = { id: randomUUID(), role, email, display_name: email, is_active: isActive, created_at: new Date() };
    users.set(user.id, user);
    return user;
  }

  function addRequest({ requester = employee, assignedTo = null, status = 'submitted', priority = 'medium', title = 'Request' } = {}) {
    const now = new Date();
    const row = {
      id: randomUUID(), requester_id: requester.id, assigned_to: assignedTo,
      category_id: categories[0].id, title, description: 'A request description',
      status, priority, created_at: now, updated_at: now,
    };
    requests.push(row);
    return row;
  }

  async function query(sql, params = [], transaction = null) {
    if (/^BEGIN$/i.test(sql.trim())) {
      if (transaction) transaction.failActivityLog = failActivityLog;
      return { rows: [] };
    }
    if (/^COMMIT$/i.test(sql.trim())) {
      if (transaction?.updatedRequest) Object.assign(transaction.updatedRequest, transaction.changes);
      if (transaction) activityLogs.push(...transaction.activityLogs);
      return { rows: [] };
    }
    if (/^ROLLBACK$/i.test(sql.trim())) return { rows: [] };

    if (/FROM public\.auth_sessions AS s/i.test(sql)) {
      const [tokenId, userId] = params;
      const session = sessions.get(tokenId);
      const user = users.get(userId);
      if (!session || session.userId !== userId || !user?.is_active) return { rows: [] };
      return { rows: [{ id: user.id, email: user.email, display_name: user.display_name, role: user.role, created_at: user.created_at }] };
    }

    if (/SELECT id, email, display_name AS "displayName"/i.test(sql)) {
      return { rows: [...users.values()]
        .filter((user) => user.role === 'staff' && user.is_active)
        .map(({ id, email, display_name: displayName }) => ({ id, email, displayName })) };
    }

    if (/SELECT count\(\*\)::int AS total FROM public\.service_requests AS r/i.test(sql)) {
      const [status, assignment, staffId] = params;
      const matching = requests.filter((row) => (!status || row.status === status)
        && (assignment === 'all'
          || (assignment === 'unassigned' && row.assigned_to === null)
          || (assignment === 'mine' && row.assigned_to === staffId)));
      return { rows: [{ total: matching.length }] };
    }

    if (/FROM public\.service_requests AS r/i.test(sql) && /WHERE r\.id = \$1/i.test(sql)) {
      const row = requests.find((item) => item.id === params[0]);
      return { rows: row ? [mapJoinedRequest(row)] : [] };
    }

    if (/FROM public\.service_requests AS r/i.test(sql) && /LIMIT \$4 OFFSET \$5/i.test(sql)) {
      const [status, assignment, staffId, limit, offset] = params;
      const matching = requests.filter((row) => (!status || row.status === status)
        && (assignment === 'all'
          || (assignment === 'unassigned' && row.assigned_to === null)
          || (assignment === 'mine' && row.assigned_to === staffId)))
        .sort((a, b) => b.created_at - a.created_at);
      return { rows: matching.slice(offset, offset + limit).map(mapJoinedRequest) };
    }

    if (/SELECT id, assigned_to, status, priority\s+FROM public\.service_requests/i.test(sql)) {
      const row = requests.find((item) => item.id === params[0]);
      if (!row) return { rows: [] };
      if (transaction) transaction.updatedRequest = row;
      return { rows: [{ id: row.id, assigned_to: row.assigned_to, status: row.status, priority: row.priority }] };
    }

    if (/SELECT id FROM public\.users\s+WHERE id = \$1 AND role = 'staff' AND is_active = true/i.test(sql)) {
      const user = users.get(params[0]);
      return { rows: user?.role === 'staff' && user.is_active ? [{ id: user.id }] : [] };
    }

    if (/UPDATE public\.service_requests SET /i.test(sql)) {
      const setClause = sql.match(/SET (.+) WHERE/i)[1];
      const columns = [...setClause.matchAll(/([a-z_]+) = \$\d+/g)].map((match) => match[1]);
      transaction.changes = Object.fromEntries(columns.map((column, index) => [column, params[index + 1]]));
      return { rows: [] };
    }

    if (/INSERT INTO public\.request_activity_logs/i.test(sql)) {
      if (transaction?.failActivityLog) throw new Error('Simulated activity log write failure');
      const [requestId, actorId, action, details] = params;
      (transaction?.activityLogs ?? activityLogs).push({
        request_id: requestId, actor_id: actorId, action, details: JSON.parse(details),
      });
      return { rows: [] };
    }

    throw new Error(`Unexpected staff test query: ${sql}`);
  }

  function mapJoinedRequest(row) {
    const requester = users.get(row.requester_id);
    const assignee = row.assigned_to ? users.get(row.assigned_to) : null;
    const category = categories.find((item) => item.id === row.category_id);
    return {
      ...row,
      requester_email: requester.email,
      requester_name: requester.display_name,
      assignee_email: assignee?.email ?? null,
      assignee_name: assignee?.display_name ?? null,
      category_slug: category.slug,
      category_name: category.name,
    };
  }

  const pool = {
    users, sessions, requests, activityLogs, employee, staff, secondStaff, inactiveStaff, addRequest,
    async query(...args) { return query(...args); },
    async connect() {
      const transaction = { activityLogs: [], changes: null, updatedRequest: null, failActivityLog: false };
      return { query: (sql, params = []) => query(sql, params, transaction), release() {} };
    },
  };
  return pool;
}

function addSession(pool, user) {
  const tokenId = randomUUID();
  pool.sessions.set(tokenId, { userId: user.id });
  const token = jwt.sign({}, jwtSecret, {
    algorithm: 'HS256', audience: jwtAudience, expiresIn: 3600,
    issuer: jwtIssuer, jwtid: tokenId, subject: user.id,
  });
  return token;
}

async function startServer(t, options) {
  const pool = createStaffTestPool(options);
  const employeeToken = addSession(pool, pool.employee);
  const staffToken = addSession(pool, pool.staff);
  const server = createApp({ pool, jwtSecret }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return { pool, employeeToken, staffToken, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function headers(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function patchRequest(baseUrl, token, id, body) {
  return fetch(`${baseUrl}/api/staff/requests/${id}`, {
    method: 'PATCH', headers: headers(token), body: JSON.stringify(body),
  });
}

describe('staff request triage API', () => {
  it('rejects unauthenticated and employee access to staff routes', async (t) => {
    const { baseUrl, employeeToken } = await startServer(t);
    const unauthenticated = await fetch(`${baseUrl}/api/staff/requests`);
    assert.equal(unauthenticated.status, 401);
    const forbidden = await fetch(`${baseUrl}/api/staff/requests`, { headers: headers(employeeToken) });
    assert.equal(forbidden.status, 403);
    const employeeUpdate = await patchRequest(baseUrl, employeeToken, randomUUID(), { status: 'closed' });
    assert.equal(employeeUpdate.status, 403);
  });

  it('lists a paginated queue with status and assignment filters and staff details', async (t) => {
    const { baseUrl, staffToken, pool } = await startServer(t);
    pool.addRequest({ title: 'Mine', assignedTo: pool.staff.id, status: 'in_progress', priority: 'high' });
    pool.addRequest({ title: 'Unassigned', status: 'submitted' });
    pool.addRequest({ title: 'Other staff', assignedTo: pool.secondStaff.id, status: 'in_progress' });

    const mine = await fetch(`${baseUrl}/api/staff/requests?assignment=mine&status=in_progress&page=1&pageSize=1`, {
      headers: headers(staffToken),
    });
    const mineBody = await mine.json();
    assert.equal(mine.status, 200);
    assert.equal(mineBody.pagination.totalItems, 1);
    assert.equal(mineBody.requests[0].title, 'Mine');
    assert.equal(mineBody.requests[0].requester.displayName, pool.employee.display_name);
    assert.equal(mineBody.requests[0].assignedTo.id, pool.staff.id);

    const unassigned = await fetch(`${baseUrl}/api/staff/requests?assignment=unassigned`, { headers: headers(staffToken) });
    assert.equal((await unassigned.json()).requests[0].title, 'Unassigned');
    const invalidFilter = await fetch(`${baseUrl}/api/staff/requests?assignment=everyone`, { headers: headers(staffToken) });
    assert.equal(invalidFilter.status, 400);
    for (const query of ['page=0', 'pageSize=51', 'status=unknown']) {
      const invalid = await fetch(`${baseUrl}/api/staff/requests?${query}`, { headers: headers(staffToken) });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error.code, 'INVALID_INPUT');
    }
  });

  it('lists active staff accounts and returns request details to staff', async (t) => {
    const { baseUrl, staffToken, pool } = await startServer(t);
    const row = pool.addRequest({ assignedTo: pool.staff.id });
    const staffList = await fetch(`${baseUrl}/api/staff/users`, { headers: headers(staffToken) });
    const staffBody = await staffList.json();
    assert.equal(staffBody.staff.length, 2);
    assert.equal(staffBody.staff.some((user) => user.id === pool.inactiveStaff.id), false);

    const detail = await fetch(`${baseUrl}/api/staff/requests/${row.id}`, { headers: headers(staffToken) });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).request.id, row.id);
  });

  it('validates updates and permits assignment only to active staff accounts', async (t) => {
    const { baseUrl, staffToken, pool } = await startServer(t);
    const row = pool.addRequest();
    for (const body of [
      { assignedTo: pool.employee.id },
      { assignedTo: pool.inactiveStaff.id },
      { assignedTo: 'not-a-uuid' },
      { status: 'unknown' },
      { priority: 'critical' },
      { status: 'resolved', requesterId: pool.employee.id },
      {},
    ]) {
      const response = await patchRequest(baseUrl, staffToken, row.id, body);
      assert.equal(response.status, 400);
    }
    assert.equal(row.assigned_to, null);
    assert.equal(pool.activityLogs.length, 0);

    const assigned = await patchRequest(baseUrl, staffToken, row.id, { assignedTo: pool.secondStaff.id });
    assert.equal(assigned.status, 200);
    assert.equal((await assigned.json()).request.assignedTo.id, pool.secondStaff.id);
    assert.deepEqual(pool.activityLogs, [{
      request_id: row.id,
      actor_id: pool.staff.id,
      action: 'request_assigned',
      details: { from: null, to: pool.secondStaff.id },
    }]);
  });

  it('updates status and priority and logs each change with the authenticated actor', async (t) => {
    const { baseUrl, staffToken, pool } = await startServer(t);
    const row = pool.addRequest();
    const response = await patchRequest(baseUrl, staffToken, row.id, { status: 'in_progress', priority: 'urgent' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.request.status, 'in_progress');
    assert.equal(body.request.priority, 'urgent');
    assert.deepEqual(pool.activityLogs.map(({ action, actor_id, details }) => ({ action, actor_id, details })), [
      { action: 'request_status_changed', actor_id: pool.staff.id, details: { from: 'submitted', to: 'in_progress' } },
      { action: 'request_priority_changed', actor_id: pool.staff.id, details: { from: 'medium', to: 'urgent' } },
    ]);
  });

  it('rolls back request changes when activity logging fails', async (t) => {
    const { baseUrl, staffToken, pool } = await startServer(t, { failActivityLog: true });
    const row = pool.addRequest();
    const response = await patchRequest(baseUrl, staffToken, row.id, {
      assignedTo: pool.secondStaff.id,
      status: 'in_progress',
      priority: 'high',
    });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
    });
    assert.equal(row.assigned_to, null);
    assert.equal(row.status, 'submitted');
    assert.equal(row.priority, 'medium');
    assert.equal(pool.activityLogs.length, 0);
  });
});
