const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendError(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

function asyncHandler(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function hasValidId(request, response) {
  if (uuidPattern.test(request.params.id)) return true;
  sendError(response, 400, 'INVALID_INPUT', 'Request ID must be a UUID.');
  return false;
}

// accessPredicate is a fixed SQL fragment selected by the owning router:
// employee routes pass "r.requester_id = $2"; staff routes pass "true".
export function registerConversationRoutes(router, { getPool, accessPredicate, includeInternalComments, prefix = '' }) {
  const verifyAccess = async (id, userId) => {
    const { rows: [row] } = await getPool().query(
      `SELECT r.id FROM public.service_requests AS r WHERE r.id = $1 AND ${accessPredicate}`,
      [id, userId],
    );
    return Boolean(row);
  };

  router.get(`${prefix}/:id/comments`, asyncHandler(async (request, response) => {
    if (!hasValidId(request, response)) return;
    if (!await verifyAccess(request.params.id, request.auth.user.id)) {
      return sendError(response, 404, 'REQUEST_NOT_FOUND', 'Service request was not found.');
    }
    const { rows } = await getPool().query(
      `SELECT c.id, c.body, c.is_internal, c.created_at,
              u.id AS author_id, u.display_name AS author_name, u.role AS author_role
         FROM public.request_comments AS c
         JOIN public.users AS u ON u.id = c.author_id
        WHERE c.request_id = $1 AND ($2::boolean OR c.is_internal = false)
        ORDER BY c.created_at ASC, c.id ASC`,
      [request.params.id, includeInternalComments],
    );
    return response.status(200).json({ comments: rows.map((row) => ({
      id: row.id,
      body: row.body,
      isInternal: row.is_internal,
      createdAt: row.created_at,
      author: { id: row.author_id, displayName: row.author_name, role: row.author_role },
    })) });
  }));

  router.post(`${prefix}/:id/comments`, asyncHandler(async (request, response) => {
    if (!hasValidId(request, response)) return;
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => key !== 'body')) {
      return sendError(response, 400, 'INVALID_INPUT', 'Comment body may include only a body field.');
    }
    const cleanBody = typeof body.body === 'string' ? body.body.trim() : '';
    if (cleanBody.length < 1 || cleanBody.length > 5000) {
      return sendError(response, 400, 'INVALID_INPUT', 'Comment must be between 1 and 5000 characters.');
    }

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const { rows: [comment] } = await client.query(
        `INSERT INTO public.request_comments (request_id, author_id, body, is_internal)
         SELECT r.id, $3, $4, false
           FROM public.service_requests AS r
          WHERE r.id = $1 AND ${accessPredicate}
         RETURNING id, request_id, author_id, body, is_internal, created_at`,
        [request.params.id, request.auth.user.id, request.auth.user.id, cleanBody],
      );
      if (!comment) {
        await client.query('ROLLBACK');
        return sendError(response, 404, 'REQUEST_NOT_FOUND', 'Service request was not found.');
      }
      await client.query(
        `INSERT INTO public.request_activity_logs (request_id, actor_id, action, details)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [request.params.id, request.auth.user.id, 'comment_added', JSON.stringify({ commentId: comment.id })],
      );
      await client.query('COMMIT');
      return response.status(201).json({ comment: {
        id: comment.id,
        body: comment.body,
        isInternal: comment.is_internal,
        createdAt: comment.created_at,
        author: { id: request.auth.user.id, displayName: request.auth.user.displayName, role: request.auth.user.role },
      } });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    } finally {
      client.release();
    }
  }));

  router.get(`${prefix}/:id/activity`, asyncHandler(async (request, response) => {
    if (!hasValidId(request, response)) return;
    if (!await verifyAccess(request.params.id, request.auth.user.id)) {
      return sendError(response, 404, 'REQUEST_NOT_FOUND', 'Service request was not found.');
    }
    const { rows } = await getPool().query(
      `SELECT l.id, l.action, l.details, l.created_at,
              u.id AS actor_id, u.display_name AS actor_name, u.role AS actor_role
         FROM public.request_activity_logs AS l
         LEFT JOIN public.users AS u ON u.id = l.actor_id
        WHERE l.request_id = $1
        ORDER BY l.created_at ASC, l.id ASC`,
      [request.params.id],
    );
    return response.status(200).json({ activity: rows.map((row) => ({
      id: row.id,
      action: row.action,
      details: row.details,
      createdAt: row.created_at,
      actor: row.actor_id ? { id: row.actor_id, displayName: row.actor_name, role: row.actor_role } : null,
    })) });
  }));
}
