import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import validator from 'validator';
import { Router } from 'express';
import { createPool } from '../db.js';

const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_SECONDS = 60 * 60;
const JWT_ISSUER = 'arrowstack-employee-service';
const JWT_AUDIENCE = 'arrowstack-client';
const dummyPasswordHash = bcrypt.hash(randomUUID(), BCRYPT_ROUNDS);

function sendError(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

function asyncHandler(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !validator.isEmail(email, { allow_utf8_local_part: true })) return null;
  return email;
}

function validatePassword(value) {
  return typeof value === 'string'
    && value.length >= 12
    && Buffer.byteLength(value, 'utf8') <= 72;
}

function safeUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at,
  };
}

function issueToken(userId, jwtSecret) {
  const tokenId = randomUUID();
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_SECONDS * 1000);
  const token = jwt.sign({}, jwtSecret, {
    algorithm: 'HS256',
    audience: JWT_AUDIENCE,
    expiresIn: ACCESS_TOKEN_SECONDS,
    issuer: JWT_ISSUER,
    jwtid: tokenId,
    subject: userId,
  });
  return { token, tokenId, expiresAt };
}

export function createAuthRouter({
  pool: providedPool,
  getPool: providedGetPool,
  authenticate: providedAuthenticate,
  jwtSecret = process.env.JWT_SECRET,
  passwordRounds = BCRYPT_ROUNDS,
} = {}) {
  const router = Router();
  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  let pool = providedPool;
  const getPool = providedGetPool ?? (() => (pool ??= createPool()));

  function isConfigured(response) {
    if (typeof jwtSecret !== 'string'
      || Buffer.byteLength(jwtSecret, 'utf8') < 32
      || jwtSecret.includes('<')
      || jwtSecret.includes('>')) {
      sendError(response, 503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured.');
      return false;
    }
    if (!providedPool && !process.env.DATABASE_URL) {
      sendError(response, 503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured.');
      return false;
    }
    return true;
  }

  router.post('/register', asyncHandler(async (request, response) => {
    if (!isConfigured(response)) return;
    const email = normalizeEmail(request.body?.email);
    const { password, displayName } = request.body ?? {};
    const name = typeof displayName === 'string' ? displayName.trim() : '';

    if (!email || !validatePassword(password) || name.length < 1 || name.length > 100) {
      return sendError(
        response,
        400,
        'INVALID_INPUT',
        'Provide a valid email, a password of 12–72 UTF-8 bytes, and a display name of 1–100 characters.',
      );
    }

    const passwordHash = await bcrypt.hash(password, passwordRounds);
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const { rows: [user] } = await client.query(
        `INSERT INTO public.users (email, display_name, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, email, display_name, role, created_at`,
        [email, name, passwordHash],
      );
      const session = issueToken(user.id, jwtSecret);
      await client.query(
        `INSERT INTO public.auth_sessions (token_id, user_id, expires_at)
         VALUES ($1, $2, $3)`,
        [session.tokenId, user.id, session.expiresAt],
      );
      await client.query('COMMIT');
      return response.status(201).json({
        token: session.token,
        tokenType: 'Bearer',
        expiresIn: ACCESS_TOKEN_SECONDS,
        user: safeUser(user),
      });
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') {
        return sendError(response, 409, 'EMAIL_ALREADY_REGISTERED', 'An account with this email already exists.');
      }
      throw error;
    } finally {
      client.release();
    }
  }));

  router.post('/login', asyncHandler(async (request, response) => {
    if (!isConfigured(response)) return;
    const email = normalizeEmail(request.body?.email);
    const { password } = request.body ?? {};
    if (!email || typeof password !== 'string' || password.length === 0 || Buffer.byteLength(password, 'utf8') > 72) {
      return sendError(response, 400, 'INVALID_INPUT', 'Provide a valid email and password.');
    }

    const { rows: [user] } = await getPool().query(
      `SELECT id, email, display_name, role, is_active, password_hash, created_at
         FROM public.users
        WHERE email = $1`,
      [email],
    );
    const passwordMatches = await bcrypt.compare(password, user?.password_hash ?? await dummyPasswordHash);
    if (!user || !user.is_active || !user.password_hash || !passwordMatches) {
      return sendError(response, 401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }

    const session = issueToken(user.id, jwtSecret);
    await getPool().query(
      `INSERT INTO public.auth_sessions (token_id, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [session.tokenId, user.id, session.expiresAt],
    );
    return response.status(200).json({
      token: session.token,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_SECONDS,
      user: safeUser(user),
    });
  }));

  const authenticate = providedAuthenticate ?? createAuthMiddleware({ pool: providedPool, getPool, jwtSecret });

  router.get('/me', authenticate, (request, response) => response.status(200).json({ user: request.auth.user }));

  router.post('/logout', authenticate, asyncHandler(async (request, response) => {
    await getPool().query(
      `UPDATE public.auth_sessions
          SET revoked_at = now()
        WHERE token_id = $1 AND revoked_at IS NULL`,
      [request.auth.tokenId],
    );
    return response.status(204).end();
  }));

  return router;
}

export function createAuthMiddleware({ pool: providedPool, getPool: providedGetPool, jwtSecret = process.env.JWT_SECRET } = {}) {
  let pool = providedPool;
  const getPool = providedGetPool ?? (() => (pool ??= createPool()));

  function isConfigured(response) {
    if (typeof jwtSecret !== 'string'
      || Buffer.byteLength(jwtSecret, 'utf8') < 32
      || jwtSecret.includes('<')
      || jwtSecret.includes('>')) {
      sendError(response, 503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured.');
      return false;
    }
    if (!providedPool && !process.env.DATABASE_URL) {
      sendError(response, 503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured.');
      return false;
    }
    return true;
  }

  return asyncHandler(async (request, response, next) => {
    if (!isConfigured(response)) return;
    const authorization = request.get('authorization') ?? '';
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!match) return sendError(response, 401, 'UNAUTHENTICATED', 'A valid bearer token is required.');

    let claims;
    try {
      claims = jwt.verify(match[1], jwtSecret, {
        algorithms: ['HS256'],
        audience: JWT_AUDIENCE,
        issuer: JWT_ISSUER,
      });
    } catch {
      return sendError(response, 401, 'UNAUTHENTICATED', 'A valid bearer token is required.');
    }
    if (typeof claims !== 'object' || typeof claims.sub !== 'string' || typeof claims.jti !== 'string') {
      return sendError(response, 401, 'UNAUTHENTICATED', 'A valid bearer token is required.');
    }

    const { rows: [user] } = await getPool().query(
      `SELECT u.id, u.email, u.display_name, u.role, u.created_at
         FROM public.auth_sessions AS s
         JOIN public.users AS u ON u.id = s.user_id
        WHERE s.token_id = $1
          AND s.user_id = $2
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND u.is_active = true`,
      [claims.jti, claims.sub],
    );
    if (!user) return sendError(response, 401, 'UNAUTHENTICATED', 'A valid bearer token is required.');
    request.auth = { tokenId: claims.jti, user: safeUser(user) };
    return next();
  });
}
