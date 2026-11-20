import { Router } from 'express';
import { createAuthMiddleware } from '../auth/router.js';
import { createPool } from '../db.js';
import { registerConversationRoutes } from './conversation.js';

const allowedCategories = ['it', 'hr', 'facilities'];
const allowedStatuses = ['submitted', 'in_progress', 'waiting_on_employee', 'resolved', 'closed'];
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
    category: {
      id: row.category_id,
      slug: row.category_slug,
      name: row.category_name,
    },
  };
}

export function createRequestRouter({
  pool: providedPool,
  getPool: providedGetPool,
  authenticate: providedAuthenticate,
  jwtSecret = process.env.JWT_SECRET,
} = {}) {
  const router = Router();
  let pool = providedPool;
  const getPool = providedGetPool ?? (() => (pool ??= createPool()));
  const authenticate = providedAuthenticate ?? createAuthMiddleware({ pool: providedPool, getPool, jwtSecret });

  router.use(authenticate);
  registerConversationRoutes(router, {
    getPool,
    accessPredicate: 'r.requester_id = $2',
    includeInternalComments: false,
  });

  router.get('/categories', asyncHandler(async (_request, response) => {
    const { rows } = await getPool().query(
      `SELECT id, slug, name
         FROM public.service_categories
        WHERE is_active = true AND slug = ANY($1::text[])
        ORDER BY name`,
      [allowedCategories],
    );
    return response.status(200).json({ categories: rows });
  }));

  router.post('/', asyncHandler(async (request, response) => {
    const { title, description, categorySlug } = request.body ?? {};
    const cleanTitle = typeof title === 'string' ? title.trim() : '';
    const cleanDescription = typeof description === 'string' ? description.trim() : '';
    const cleanCategorySlug = typeof categorySlug === 'string' ? categorySlug.trim().toLowerCase() : '';
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['title', 'description', 'categorySlug'].includes(key))) {
      return sendError(response, 400, 'INVALID_INPUT', 'Request body may include only title, description, and categorySlug.');
    }

    if (cleanTitle.length < 1 || cleanTitle.length > 160
      || cleanDescription.length < 1 || cleanDescription.length > 10000) {
      return sendError(response, 400, 'INVALID_INPUT', 'Title must be 1–160 characters and description 1–10000 characters.');
    }
    if (!allowedCategories.includes(cleanCategorySlug)) {
      return sendError(response, 400, 'INVALID_CATEGORY', 'Choose IT, HR, or Facilities as the request category.');
    }

    const { rows: [category] } = await getPool().query(
      `SELECT id, slug, name
         FROM public.service_categories
        WHERE slug = $1 AND is_active = true`,
      [cleanCategorySlug],
    );
    if (!category) return sendError(response, 400, 'INVALID_CATEGORY', 'Choose an active IT, HR, or Facilities category.');

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const { rows: [requestRow] } = await client.query(
        `INSERT INTO public.service_requests (requester_id, category_id, title, description)
         VALUES ($1, $2, $3, $4)
         RETURNING id, title, description, status, priority, created_at, updated_at`,
        [request.auth.user.id, category.id, cleanTitle, cleanDescription],
      );
      await client.query(
        `INSERT INTO public.request_activity_logs (request_id, actor_id, action, details)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [requestRow.id, request.auth.user.id, 'request_created', JSON.stringify({ categorySlug: category.slug })],
      );
      await client.query('COMMIT');
      return response.status(201).json({
        request: mapRequest({ ...requestRow, category_id: category.id, category_slug: category.slug, category_name: category.name }),
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
      if (error.code === '23503') {
        return sendError(response, 400, 'INVALID_CATEGORY', 'Choose an active IT, HR, or Facilities category.');
      }
      throw error;
    } finally {
      client.release();
    }
  }));

  router.get('/', asyncHandler(async (request, response) => {
    const page = parsePositiveInteger(request.query.page, 1, 1000000);
    const pageSize = parsePositiveInteger(request.query.pageSize, 10, 50);
    const status = request.query.status;

    if (page === null || pageSize === null
      || (status !== undefined && (typeof status !== 'string' || !allowedStatuses.includes(status)))) {
      return sendError(response, 400, 'INVALID_INPUT', 'Use a positive page, pageSize from 1–50, and a valid request status.');
    }

    const where = ['requester_id = $1'];
    const filterValues = [request.auth.user.id];
    if (status !== undefined) {
      filterValues.push(status);
      where.push(`status = $${filterValues.length}`);
    }
    const whereSql = where.join(' AND ');
    const { rows: [{ total }] } = await getPool().query(
      `SELECT count(*)::int AS total FROM public.service_requests WHERE ${whereSql}`,
      filterValues,
    );
    const offset = (page - 1) * pageSize;
    const listValues = [...filterValues, pageSize, offset];
    const { rows } = await getPool().query(
      `SELECT r.id, r.title, r.description, r.status, r.priority, r.created_at, r.updated_at,
              c.id AS category_id, c.slug AS category_slug, c.name AS category_name
         FROM public.service_requests AS r
         JOIN public.service_categories AS c ON c.id = r.category_id
        WHERE ${whereSql.replaceAll('requester_id', 'r.requester_id').replaceAll('status =', 'r.status =')}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
      listValues,
    );
    const totalItems = Number(total);
    return response.status(200).json({
      requests: rows.map(mapRequest),
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / pageSize)),
      },
    });
  }));

  router.get('/:id', asyncHandler(async (request, response) => {
    if (!uuidPattern.test(request.params.id)) {
      return sendError(response, 400, 'INVALID_INPUT', 'Request ID must be a UUID.');
    }
    const { rows: [row] } = await getPool().query(
      `SELECT r.id, r.title, r.description, r.status, r.priority, r.created_at, r.updated_at,
              c.id AS category_id, c.slug AS category_slug, c.name AS category_name
         FROM public.service_requests AS r
         JOIN public.service_categories AS c ON c.id = r.category_id
        WHERE r.id = $1 AND r.requester_id = $2`,
      [request.params.id, request.auth.user.id],
    );
    if (!row) return sendError(response, 404, 'REQUEST_NOT_FOUND', 'Service request was not found.');
    return response.status(200).json({ request: mapRequest(row) });
  }));

  return router;
}
