import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';

const jwtSecret = 'request-test-signing-key-that-is-at-least-32-bytes-long';
const jwtIssuer = 'arrowstack-employee-service';
const jwtAudience = 'arrowstack-client';

function createMemoryPool({ failActivityLog = false } = {}) {
  const categories = [
    { id: randomUUID(), slug: 'it', name: 'IT', is_active: true },
    { id: randomUUID(), slug: 'hr', name: 'HR', is_active: true },
    { id: randomUUID(), slug: 'facilities', name: 'Facilities', is_active: true },
  ];
  const users = new Map();
  const sessions = new Map();
  const requests = [];
  const activityLogs = [];

  async function query(sql, params = [], transaction = null) {
    if (/^BEGIN$/i.test(sql.trim())) return { rows: [] };
    if (/^COMMIT$/i.test(sql.trim())) {
      if (transaction) {
        requests.push(...transaction.requests);
        activityLogs.push(...transaction.activityLogs);
        transaction.requests.length = 0;
        transaction.activityLogs.length = 0;
      }
      return { rows: [] };
    }
    if (/^ROLLBACK$/i.test(sql.trim())) {
      if (transaction) {
        transaction.requests.length = 0;
        transaction.activityLogs.length = 0;
      }
      return { rows: [] };
    }

    if (/FROM public\.auth_sessions AS s/i.test(sql)) {
      const [tokenId, userId] = params;
      const session = sessions.get(tokenId);
      const user = users.get(userId);
      if (!session || session.userId !== userId || session.revoked || !user?.is_active) return { rows: [] };
      return { rows: [{ id: user.id, email: user.email, display_name: user.display_name, role: user.role, created_at: user.created_at }] };
    }

    if (/SELECT id, slug, name/i.test(sql) && /FROM public\.service_categories/i.test(sql)) {
      const rows = sql.includes('ANY($1::text[])')
        ? categories.filter((category) => category.is_active && params[0].includes(category.slug))
        : categories.filter((category) => category.slug === params[0] && category.is_active);
      return { rows };
    }

    if (/INSERT INTO public\.service_requests/i.test(sql)) {
      const [requesterId, categoryId, title, description] = params;
      const now = new Date();
      const row = {
        id: randomUUID(), requester_id: requesterId, category_id: categoryId,
        title, description, status: 'submitted', priority: 'medium', created_at: now, updated_at: now,
      };
      (transaction?.requests ?? requests).push(row);
      return { rows: [{
        id: row.id, title, description, status: row.status, priority: row.priority,
        created_at: row.created_at, updated_at: row.updated_at,
      }] };
    }

    if (/INSERT INTO public\.request_activity_logs/i.test(sql)) {
      if (transaction?.failActivityLog) {
        const error = new Error('Simulated activity log storage failure');
        error.code = 'XX000';
        throw error;
      }
      const [requestId, actorId, action, details] = params;
      (transaction?.activityLogs ?? activityLogs).push({
        request_id: requestId, actor_id: actorId, action, details: JSON.parse(details),
      });
      return { rows: [] };
    }

    if (/SELECT count\(\*\)::int AS total/i.test(sql)) {
      const [userId, status] = params;
      const own = requests.filter((row) => row.requester_id === userId && (!status || row.status === status));
      return { rows: [{ total: own.length }] };
    }

    if (/FROM public\.service_requests AS r/i.test(sql) && /LIMIT \$/.test(sql)) {
      const [userId, status, limit, offset] = params.length === 4
        ? params
        : [params[0], null, params[1], params[2]];
      const own = requests
        .filter((row) => row.requester_id === userId && (!status || row.status === status))
        .sort((left, right) => right.created_at - left.created_at || right.id.localeCompare(left.id));
      const rows = own.slice(offset, offset + limit).map((row) => ({
        ...row,
        category_slug: categories.find((category) => category.id === row.category_id).slug,
        category_name: categories.find((category) => category.id === row.category_id).name,
      }));
      return { rows };
    }

    if (/FROM public\.service_requests AS r/i.test(sql) && /WHERE r\.id = \$1 AND r\.requester_id = \$2/i.test(sql)) {
      const [requestId, userId] = params;
      const row = requests.find((item) => item.id === requestId && item.requester_id === userId);
      if (!row) return { rows: [] };
      const category = categories.find((item) => item.id === row.category_id);
      return { rows: [{
        ...row,
        category_slug: category.slug,
        category_name: category.name,
      }] };
    }

    throw new Error(`Unexpected test query: ${sql}`);
  }

  return {
    users,
    sessions,
    requests,
    activityLogs,
    categories,
    async query(...args) { return query(...args); },
    async connect() {
      const transaction = { requests: [], activityLogs: [], failActivityLog: false };
      return {
        query(sql, params = []) {
          if (/^BEGIN$/i.test(sql.trim())) transaction.failActivityLog = failActivityLog;
          return query(sql, params, transaction);
        },
        release() {},
      };
    },
  };
}

function createEmployee(pool, email) {
  const id = randomUUID();
  const user = { id, email, display_name: email, role: 'employee', is_active: true, created_at: new Date() };
  const tokenId = randomUUID();
  pool.users.set(id, user);
  pool.sessions.set(tokenId, { userId: id, revoked: false });
  const token = jwt.sign({}, jwtSecret, {
    algorithm: 'HS256',
    audience: jwtAudience,
    expiresIn: 3600,
    issuer: jwtIssuer,
    jwtid: tokenId,
    subject: id,
  });
  return { user, token };
}

async function startServer(t, options) {
  const pool = createMemoryPool(options);
  const owner = createEmployee(pool, 'owner@example.com');
  const other = createEmployee(pool, 'other@example.com');
  const server = createApp({ pool, jwtSecret }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return { pool, owner, other, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function createRequest(baseUrl, token, body) {
  return fetch(`${baseUrl}/api/requests`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

describe('employee service request API', () => {
  it('rejects unauthenticated request and category access', async (t) => {
    const { baseUrl } = await startServer(t);
    for (const path of ['/api/requests', '/api/requests/categories', `/api/requests/${randomUUID()}`]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, 'UNAUTHENTICATED');
    }
    const createResponse = await fetch(`${baseUrl}/api/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'No token', description: 'Should not be created', categorySlug: 'it' }),
    });
    assert.equal(createResponse.status, 401);
  });

  it('creates an owned request and writes its creation activity log', async (t) => {
    const { baseUrl, owner, pool } = await startServer(t);
    const response = await createRequest(baseUrl, owner.token, {
      title: '  Laptop setup  ',
      description: 'Please prepare a laptop for my first day.',
      categorySlug: 'IT',
    });
    const { request } = await response.json();

    assert.equal(response.status, 201);
    assert.equal(request.title, 'Laptop setup');
    assert.equal(request.category.slug, 'it');
    assert.equal(request.status, 'submitted');
    assert.equal(request.priority, 'medium');
    assert.equal(pool.requests[0].requester_id, owner.user.id);
    assert.equal(pool.activityLogs.length, 1);
    assert.deepEqual(pool.activityLogs[0], {
      request_id: request.id,
      actor_id: owner.user.id,
      action: 'request_created',
      details: { categorySlug: 'it' },
    });
  });

  it('validates titles, descriptions, and allowed categories', async (t) => {
    const { baseUrl, owner, pool } = await startServer(t);
    const invalidBodies = [
      { title: '   ', description: 'A valid description', categorySlug: 'it' },
      { title: 'A valid title', description: '   ', categorySlug: 'it' },
      { title: 'A valid title', description: 'A valid description', categorySlug: 'finance' },
      { title: 'A valid title', description: 'A valid description', categorySlug: 'it', requesterId: randomUUID() },
    ];

    for (const body of invalidBodies) {
      const response = await createRequest(baseUrl, owner.token, body);
      assert.equal(response.status, 400);
      assert.ok((await response.json()).error.code.startsWith('INVALID_'));
    }
    assert.equal(pool.requests.length, 0);
    assert.equal(pool.activityLogs.length, 0);
  });

  it('accepts maximum title and description lengths and rejects values over either limit', async (t) => {
    const { baseUrl, owner, pool } = await startServer(t);
    const maximumTitle = 'T'.repeat(160);
    const maximumDescription = 'D'.repeat(10000);
    const accepted = await createRequest(baseUrl, owner.token, {
      title: maximumTitle, description: maximumDescription, categorySlug: 'it',
    });
    assert.equal(accepted.status, 201);
    const acceptedBody = await accepted.json();
    assert.equal(acceptedBody.request.title.length, 160);
    assert.equal(acceptedBody.request.description.length, 10000);

    for (const body of [
      { title: `${maximumTitle}T`, description: 'Valid description', categorySlug: 'it' },
      { title: 'Valid title', description: `${maximumDescription}D`, categorySlug: 'it' },
    ]) {
      const response = await createRequest(baseUrl, owner.token, body);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'INVALID_INPUT');
    }
    assert.equal(pool.requests.length, 1);
    assert.equal(pool.activityLogs.length, 1);
  });

  it('rejects categories that are missing or inactive in the database', async (t) => {
    const { baseUrl, owner, pool } = await startServer(t);
    const facilities = pool.categories.find((category) => category.slug === 'facilities');
    pool.categories.splice(pool.categories.indexOf(facilities), 1);
    pool.categories.find((category) => category.slug === 'hr').is_active = false;

    for (const categorySlug of ['facilities', 'hr']) {
      const response = await createRequest(baseUrl, owner.token, {
        title: 'Valid title', description: 'Valid description', categorySlug,
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'INVALID_CATEGORY');
    }
    assert.equal(pool.requests.length, 0);
    assert.equal(pool.activityLogs.length, 0);
  });

  it('rolls back the request when writing its activity log fails', async (t) => {
    const { baseUrl, owner, pool } = await startServer(t, { failActivityLog: true });
    const response = await createRequest(baseUrl, owner.token, {
      title: 'Rollback request', description: 'Its activity log will fail.', categorySlug: 'it',
    });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
    });
    assert.equal(pool.requests.length, 0);
    assert.equal(pool.activityLogs.length, 0);
  });

  it('lists only owned requests with status filters and pagination', async (t) => {
    const { baseUrl, owner, other, pool } = await startServer(t);
    const ownResponse = await createRequest(baseUrl, owner.token, {
      title: 'My request', description: 'Owner-only request', categorySlug: 'hr',
    });
    const ownRequest = (await ownResponse.json()).request;
    pool.requests.push({
      id: randomUUID(), requester_id: owner.user.id, category_id: pool.categories[0].id,
      title: 'In progress request', description: 'Filtered request', status: 'in_progress',
      priority: 'high', created_at: new Date(Date.now() + 1000), updated_at: new Date(),
    });
    pool.requests.push({
      id: randomUUID(), requester_id: other.user.id, category_id: pool.categories[0].id,
      title: 'Other employee request', description: 'Must stay private', status: 'submitted',
      priority: 'medium', created_at: new Date(), updated_at: new Date(),
    });

    const filtered = await fetch(`${baseUrl}/api/requests?status=in_progress&page=1&pageSize=1`, {
      headers: authHeaders(owner.token),
    });
    const filteredBody = await filtered.json();
    assert.equal(filtered.status, 200);
    assert.equal(filteredBody.requests.length, 1);
    assert.equal(filteredBody.requests[0].title, 'In progress request');
    assert.equal(filteredBody.pagination.totalItems, 1);
    assert.equal(filteredBody.pagination.page, 1);

    const firstPage = await fetch(`${baseUrl}/api/requests?page=1&pageSize=1`, { headers: authHeaders(owner.token) });
    assert.equal((await firstPage.json()).requests.length, 1);
    const secondPage = await fetch(`${baseUrl}/api/requests?page=2&pageSize=1`, { headers: authHeaders(owner.token) });
    assert.equal((await secondPage.json()).requests.length, 1);

    const otherList = await fetch(`${baseUrl}/api/requests`, { headers: authHeaders(other.token) });
    const otherBody = await otherList.json();
    assert.equal(otherBody.pagination.totalItems, 1);
    assert.equal(otherBody.requests[0].title, 'Other employee request');
    assert.equal(JSON.stringify(otherBody).includes(ownRequest.id), false);
  });

  it('returns details only to the owning employee and validates pagination/status', async (t) => {
    const { baseUrl, owner, other } = await startServer(t);
    const response = await createRequest(baseUrl, owner.token, {
      title: 'Private request', description: 'Only the requester can see this.', categorySlug: 'facilities',
    });
    const { request } = await response.json();

    const ownDetails = await fetch(`${baseUrl}/api/requests/${request.id}`, { headers: authHeaders(owner.token) });
    assert.equal(ownDetails.status, 200);
    assert.equal((await ownDetails.json()).request.id, request.id);

    const otherDetails = await fetch(`${baseUrl}/api/requests/${request.id}`, { headers: authHeaders(other.token) });
    assert.equal(otherDetails.status, 404);
    assert.equal((await otherDetails.json()).error.code, 'REQUEST_NOT_FOUND');

    const invalidPage = await fetch(`${baseUrl}/api/requests?page=0`, { headers: authHeaders(owner.token) });
    assert.equal(invalidPage.status, 400);
    const invalidStatus = await fetch(`${baseUrl}/api/requests?status=unknown`, { headers: authHeaders(owner.token) });
    assert.equal(invalidStatus.status, 400);
  });
});
