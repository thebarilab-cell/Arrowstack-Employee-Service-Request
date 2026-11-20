import express from 'express';
import { createAuthMiddleware, createAuthRouter } from './auth/router.js';
import { createRequestRouter } from './requests/router.js';
import { createStaffRouter } from './staff/router.js';
import { createPool } from './db.js';

const requiredRelations = [
  'public.schema_migrations',
  'public.users',
  'public.auth_sessions',
  'public.service_categories',
  'public.service_requests',
  'public.request_comments',
  'public.request_activity_logs',
];

export function createApp(options = {}) {
  const app = express();
  let pool = options.pool;
  const getPool = options.getPool ?? (() => (pool ??= createPool()));
  const apiOptions = { ...options, getPool };
  const authenticate = options.authenticate ?? createAuthMiddleware(apiOptions);

  app.disable('x-powered-by');
  app.use(express.json());
  app.use('/api/auth', createAuthRouter({ ...apiOptions, authenticate }));
  app.use('/api/requests', createRequestRouter({ ...apiOptions, authenticate }));
  app.use('/api/staff', createStaffRouter({ ...apiOptions, authenticate }));
  app.get('/api/health', (_request, response) => {
    response.status(200).json({ status: 'ok', service: 'employee-service-api' });
  });
  app.get('/api/ready', async (_request, response) => {
    try {
      const { rows } = await getPool().query(
        `SELECT relation_name, to_regclass(relation_name) IS NOT NULL AS available
           FROM unnest($1::text[]) AS required(relation_name)`,
        [requiredRelations],
      );
      if (rows.length !== requiredRelations.length || rows.some((row) => !row.available)) {
        return response.status(503).json({
          error: { code: 'DATABASE_NOT_READY', message: 'Database connection or required schema is not ready.' },
        });
      }
      return response.status(200).json({ status: 'ready', service: 'employee-service-api' });
    } catch {
      return response.status(503).json({
        error: { code: 'DATABASE_NOT_READY', message: 'Database connection or required schema is not ready.' },
      });
    }
  });

  app.use((error, _request, response, _next) => {
    if (error?.type === 'entity.parse.failed') {
      return response.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } });
    }
    if (error?.type === 'entity.too.large') {
      return response.status(413).json({ error: { code: 'REQUEST_TOO_LARGE', message: 'Request body is too large.' } });
    }
    return response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
  });

  return app;
}
