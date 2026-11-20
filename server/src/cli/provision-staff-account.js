import validator from 'validator';

export function validateStaffProvisionInput({ email, displayName, password, confirmation }) {
  if (typeof email !== 'string') throw new Error('Enter a valid email address.');
  const normalizedEmail = email.trim().toLowerCase();
  if (normalizedEmail.length > 254 || !validator.isEmail(normalizedEmail, { allow_utf8_local_part: true })) {
    throw new Error('Enter a valid email address.');
  }

  if (typeof displayName !== 'string' || displayName.trim().length < 1 || displayName.trim().length > 100) {
    throw new Error('Display name must be between 1 and 100 characters.');
  }
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('Use a password of 12–72 UTF-8 bytes.');
  }
  if (password !== confirmation) throw new Error('The passwords did not match.');

  return { email: normalizedEmail, displayName: displayName.trim(), password };
}

export async function provisionStaffAccount(client, { email, displayName, passwordHash }) {
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const { rows: existing } = await client.query(
      `SELECT id
         FROM public.users
        WHERE lower(email) = $1
        FOR UPDATE`,
      [email],
    );
    if (existing.length > 0) {
      const error = new Error('An account with that email already exists. No role was changed.');
      error.code = 'STAFF_ACCOUNT_EXISTS';
      throw error;
    }

    const { rows: [user] } = await client.query(
      `INSERT INTO public.users (email, display_name, role, password_hash)
       VALUES ($1, $2, 'staff', $3)
       RETURNING id`,
      [email, displayName, passwordHash],
    );
    await client.query('COMMIT');
    transactionOpen = false;
    return user;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
    }
    if (error.code === '23505') {
      const duplicate = new Error('An account with that email already exists. No role was changed.');
      duplicate.code = 'STAFF_ACCOUNT_EXISTS';
      throw duplicate;
    }
    throw error;
  }
}
