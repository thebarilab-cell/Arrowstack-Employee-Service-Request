import '../load-env.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import bcrypt from 'bcrypt';
import { createPool } from '../db.js';
import { LOCAL_EMPLOYEE_DATABASE, validateConnectedDatabase, validateLocalStaffProvisionTarget } from './local-reset-target.js';
import { provisionStaffAccount, validateStaffProvisionInput } from './provision-staff-account.js';

const BCRYPT_ROUNDS = 12;

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
        if (character === '\u0008' || character === '\u007f') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const databaseName = validateLocalStaffProvisionTarget(process.env.DATABASE_URL, process.env.NODE_ENV);

  const confirmation = await promptLine(`Type ${databaseName} to confirm the local database target: `);
  if (confirmation.trim() !== LOCAL_EMPLOYEE_DATABASE) {
    throw new Error('Database target confirmation did not match. No changes were made.');
  }

  const pool = createPool(process.env.DATABASE_URL);
  let client;
  try {
    client = await pool.connect();
    const { rows: [identity] } = await client.query(
      'SELECT current_database() AS database_name, inet_server_addr()::text AS server_address',
    );
    try {
      validateConnectedDatabase(identity?.database_name, identity?.server_address);
    } catch {
      throw new Error('Connected PostgreSQL server is not the expected local development database.');
    }

    const displayName = await promptLine('Staff display name: ');
    const email = await promptLine('New staff email: ');
    const password = await promptHidden('New password (input hidden): ');
    const confirmationPassword = await promptHidden('Confirm new password (input hidden): ');
    const input = validateStaffProvisionInput({ email, displayName, password, confirmation: confirmationPassword });
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    await provisionStaffAccount(client, {
      email: input.email,
      displayName: input.displayName,
      passwordHash,
    });
    stdout.write('New staff account provisioned. No existing roles or sessions were changed.\n');
  } finally {
    try { client?.release(); } finally { await pool.end(); }
  }
}

const safeErrors = new Set([
  'Staff provisioning is restricted to the local development database.',
  'Connected PostgreSQL server is not the expected local development database.',
  'Database target confirmation did not match. No changes were made.',
  'Run this command in an interactive terminal.',
  'Input cancelled.',
  'Enter a valid email address.',
  'Display name must be between 1 and 100 characters.',
  'Use a password of 12–72 UTF-8 bytes.',
  'The passwords did not match.',
  'An account with that email already exists. No role was changed.',
]);

main().catch((error) => {
  console.error(safeErrors.has(error.message)
    ? error.message
    : 'Staff provisioning failed. No database error details or credentials were displayed.');
  process.exitCode = 1;
});
