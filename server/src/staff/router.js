import { Router } from 'express';
import { createAuthMiddleware } from '../auth/router.js';
import { createPool } from '../db.js';
import { registerConversationRoutes } from '../requests/conversation.js';

const statuses = ['submitted', 'in_progress', 'waiting_on_employee', 'resolved', 'closed'];
const priorities = ['low', 'medium', 'high', 'urgent'];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendError(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

function asyncHandler(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function parsePositiveInteger(value, fallback, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : null;
}

function mapRequest(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    category: { id: row.category_id, slug: row.category_slug, name: row.category_name },
    requester: { id: row.requester_id, email: row.requester_email, displayName: row.requester_name },
    assignedTo: row.assigned_to ? {
      id: row.assigned_to,
      email: row.assignee_email,
      displayName: row.assignee_name,
    } : null,
  };
}

const requestSelect = `SELECT r.id, r.title, r.description, r.status, r.priority, r.created_at, r.updated_at,
                              r.requester_id, requester.email AS requester_email,
                              requester.display_name AS requester_name, r.assigned_to,
                              assignee.email AS assignee_email, assignee.display_name AS assignee_name,
                              c.id AS category_id, c.slug AS category_slug, c.name AS category_name
                         FROM public.service_requests AS r
                         JOIN public.users AS requester ON requester.id = r.requester_id
                         LEFT JOIN public.users AS assignee ON assignee.id = r.assigned_to
                         JOIN public.service_categories AS c ON c.id = r.category_id`;

export function createStaffRouter({
  pool: providedPool,
  getPool: providedGetPool,
  authenticate: providedAuthenticate,
  jwtSecret = process.env.JWT_SECRET,
} = {}) {
  const router = Router();
  let pool = providedPool;
  const getPool = providedGetPool ?? (() => (pool ??= createPool()));
  const authenticate = providedAuthenticate ?? createAuthMiddleware({ pool: providedPool, getPool, jwtSecret });

  router.use(authenticate, (request, response, next) => {
    if (request.auth.user.role !== 'staff') {
      return sendError(response, 403, 'FORBIDDEN', 'Staff access is required.');
    }
    return next();
  });
  registerConversationRoutes(router, {
    getPool,
    accessPredicate: '$2::uuid IS NOT NULL',
    includeInternalComments: true,
    prefix: '/requests',
  });

  router.get('/users', asyncHandler(async (_request, response) => {
    const { rows } = await getPool().query(
      `SELECT id, email, display_name AS "displayName"
         FROM public.users
        WHERE role = 'staff' AND is_active = true
        ORDER BY display_name, id`,
    );
    return response.status(200).json({ staff: rows });
  }));

  router.get('/requests', asyncHandler(async (request, response) => {
    const page = parsePositiveInteger(request.query.page, 1, 1000000);
    const pageSize = parsePositiveInteger(request.query.pageSize, 10, 50);
    const status = request.query.status;
    const assignment = request.query.assignment ?? 'all';
    if (page === null || pageSize === null
      || (status !== undefined && (typeof status !== 'string' || !statuses.includes(status)))
      || !['all', 'unassigned', 'mine'].includes(assignment)) {
      return sendError(response, 400, 'INVALID_INPUT', 'Use a positive page, pageSize from 1–50, a valid status, and assignment all, unassigned, or mine.');
    }

    const values = [status ?? null, assignment, request.auth.user.id];
    const where = `($1::text IS NULL OR r.status = $1)
                   AND ($2::text = 'all'
                     OR ($2::text = 'unassigned' AND r.assigned_to IS NULL)
                     OR ($2::text = 'mine' AND r.assigned_to = $3))`;
    const { rows: [{ total }] } = await getPool().query(
      `SELECT count(*)::int AS total FROM public.service_requests AS r WHERE ${where}`,
      values,
    );
    const offset = (page - 1) * pageSize;
    const { rows } = await getPool().query(
      `${requestSelect}
        WHERE ${where}
        ORDER BY CASE r.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                 r.created_at DESC, r.id DESC
        LIMIT $4 OFFSET $5`,
      [...values, pageSize, offset],
    );
    const totalItems = Number(total);
    return response.status(200).json({
      requests: rows.map(mapRequest),
      pagination: { page, pageSize, totalItems, totalPages: Math.max(1, Math.ceil(totalItems / pageSize)) },
    });
  }));

  router.get('/requests/:id', asyncHandler(async (request, response) => {
    if (!uuidPattern.test(request.params.id)) {
      return sendError(response, 400, 'INVALID_INPUT', 'Request ID must be a UUID.');
    }
    const { rows: [row] } = await getPool().query(
      `${requestSelect} WHERE r.id = $1`,
      [request.params.id],
    );
    if (!row) return sendError(response, 404, 'REQUEST_NOT_FOUND', 'Service request was not found.');
    return response.status(200).json({ request: mapRequest(row) });
  }));

  router.patch('/requests/:id', asyncHandler(async (request, response) => {
    if (!uuidPattern.test(request.params.id)) {
      return sendError(response, 400, 'INVALID_INPUT', 'Request ID must be a UUID.');
    }
    const body = request.body;
    const allowedFields = ['assignedTo', 'status', 'priority'];
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length === 0
      || Object.keys(body).some((key) => !allowedFields.includes(key))) {
      return sendError(response, 400, 'INVALID_INPUT', 'Provide one or more of assignedTo, status, and priority.');
    }
    if (Object.hasOwn(body, 'assignedTo') && body.assignedTo !== null
      && (typeof body.assignedTo !== 'string' || !uuidPattern.test(body.assignedTo))) {
      return sendError(response, 400, 'INVALID_ASSIGNEE', 'assignedTo must be a staff user UUID or null.');
    }
    if (Object.hasOwn(body, 'status') && !statuses.includes(body.status)) {
      return sendError(response, 400, 'INVALID_STATUS', 'Choose a valid request status.');
    }
    if (Object.hasOwn(body, 'priority') && !priorities.includes(body.priority)) {
      return sendError(response, 400, 'INVALID_PRIORITY', 'Choose a valid request priority.');
    }

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const { rows: [current] } = await client.query(
        `SELECT id, assigned_to, status, priority
           FROM public.service_requests
          WHERE id = $1
          FOR UPDATE`,
        [request.params.id],
      );
      if (!current) {
        await client.query('ROLLBACK');
        return sendError(response, 404, 'REQUEST_NOT_FOUND', 'Service request was not found.');
      }

      if (Object.hasOwn(body, 'assignedTo') && body.assignedTo !== null) {
        const { rows: [assignee] } = await client.query(
          `SELECT id FROM public.users
            WHERE id = $1 AND role = 'staff' AND is_active = true
            FOR SHARE`,
          [body.assignedTo],
        );
        if (!assignee) {
          await client.query('ROLLBACK');
          return sendError(response, 400, 'INVALID_ASSIGNEE', 'Choose an active staff account for assignment.');
        }
      }

      const changes = [];
      if (Object.hasOwn(body, 'assignedTo') && body.assignedTo !== current.assigned_to) {
        changes.push({ column: 'assigned_to', value: body.assignedTo, action: body.assignedTo ? 'request_assigned' : 'request_unassigned', from: current.assigned_to, to: body.assignedTo });
      }
      if (Object.hasOwn(body, 'status') && body.status !== current.status) {
        changes.push({ column: 'status', value: body.status, action: 'request_status_changed', from: current.status, to: body.status });
      }
      if (Object.hasOwn(body, 'priority') && body.priority !== current.priority) {
        changes.push({ column: 'priority', value: body.priority, action: 'request_priority_changed', from: current.priority, to: body.priority });
      }

      if (changes.length) {
        const updateValues = changes.map((change) => change.value);
        const setSql = changes.map((change, index) => `${change.column} = $${index + 2}`).join(', ');
        await client.query(
          `UPDATE public.service_requests SET ${setSql} WHERE id = $1`,
          [request.params.id, ...updateValues],
        );
        for (const change of changes) {
          await client.query(
            `INSERT INTO public.request_activity_logs (request_id, actor_id, action, details)
             VALUES ($1, $2, $3, $4::jsonb)`,
            [request.params.id, request.auth.user.id, change.action, JSON.stringify({ from: change.from, to: change.to })],
          );
        }
      }
      await client.query('COMMIT');

      const { rows: [updated] } = await getPool().query(
        `${requestSelect} WHERE r.id = $1`,
        [request.params.id],
      );
      return response.status(200).json({ request: mapRequest(updated) });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
      if (error.code === '23514' && error.constraint === 'service_requests_assigned_staff') {
        return sendError(response, 400, 'INVALID_ASSIGNEE', 'Choose an active staff account for assignment.');
      }
      throw error;
    } finally {
      client.release();
    }
  }));

  return router;
}
