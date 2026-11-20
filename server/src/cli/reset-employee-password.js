import '../load-env.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import bcrypt from 'bcrypt';
import validator from 'validator';
import { createPool } from '../db.js';
import {
  LOCAL_EMPLOYEE_DATABASE,
  validateConnectedDatabase,
  validateLocalResetTarget,
} from './local-reset-target.js';

const BCRYPT_ROUNDS = 12;

function normalizeEmail(value) {
  const email = value.trim().toLowerCase();
  return email.length <= 254 && validator.isEmail(email, { allow_utf8_local_part: true }) ? email : null;
}

function promptLine(label) {
  const prompt = createInterface({ input: stdin, output: stdout });
  return prompt.question(label).finally(() => prompt.close());
}

function promptHidden(label) {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Run this command in an interactive terminal.'));
  }

  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') return finish(new Error('Input cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u0008' || character === '\u007f') {
          value = value.slice(0, -1);
        } else if (character >= ' ') {
          value += character;
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  const databaseName = validateLocalResetTarget(connectionString, process.env.NODE_ENV);
  const databaseConfirmation = await promptLine(`Type ${databaseName} to confirm the local database target: `);
  if (databaseConfirmation.trim() !== LOCAL_EMPLOYEE_DATABASE) {
    throw new Error('Database target confirmation did not match. No changes were made.');
  }

  const emailInput = await promptLine('Existing employee email: ');
  const email = normalizeEmail(emailInput);
  if (!email) throw new Error('Enter a valid email address.');

  const password = await promptHidden('New password (input hidden): ');
  const passwordConfirmation = await promptHidden('Confirm new password (input hidden): ');
  if (password !== passwordConfirmation) throw new Error('The passwords did not match.');
  if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('Use a password of 12–72 UTF-8 bytes.');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const pool = createPool(connectionString);
  let client;
  let transactionOpen = false;
  try {
    client = await pool.connect();
    const { rows: [databaseIdentity] } = await client.query(
      'SELECT current_database() AS database_name, inet_server_addr()::text AS server_address',
    );
    validateConnectedDatabase(databaseIdentity?.database_name, databaseIdentity?.server_address);
    await client.query('BEGIN');
    transactionOpen = true;

    const { rows } = await client.query(
      `SELECT id
         FROM public.users
        WHERE lower(email) = $1 AND role = 'employee' AND is_active = true
        FOR UPDATE`,
      [email],
    );
    if (rows.length !== 1) throw new Error('No unique active employee account matched that email.');

    const userId = rows[0].id;
    const result = await client.query(
      `UPDATE public.users
          SET password_hash = $1
        WHERE id = $2 AND role = 'employee' AND is_active = true`,
      [passwordHash, userId],
    );
    if (result.rowCount !== 1) throw new Error('The employee account could not be updated.');

    await client.query(
      `UPDATE public.auth_sessions
          SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    await client.query('COMMIT');
    transactionOpen = false;
    stdout.write('Employee password reset completed. Existing active sessions were revoked.\n');
  } finally {
    if (transactionOpen && client) {
      try { await client.query('ROLLBACK'); } catch { /* do not print database errors */ }
    }
    try { client?.release(); } finally { await pool.end(); }
  }
}

main().catch((error) => {
  const safeMessages = new Set([
    'Run this command in an interactive terminal.',
    'Password reset is restricted to the local development database.',
    'Connected PostgreSQL server is not the expected local development database.',
    'Database target confirmation did not match. No changes were made.',
    'Input cancelled.',
    'Enter a valid email address.',
    'The passwords did not match.',
    'Use a password of 12–72 UTF-8 bytes.',
    'No unique active employee account matched that email.',
    'The employee account could not be updated.',
  ]);
  const message = safeMessages.has(error.message)
    ? error.message
    : 'Password reset failed. No database error details or credentials were displayed.';
  console.error(message);
  process.exitCode = 1;
});
