import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const envPath = fileURLToPath(new URL('../../../.env', import.meta.url));

try {
  const contents = await readFile(envPath, 'utf8');
  const existing = dotenv.parse(contents).JWT_SECRET;
  const isPlaceholder = typeof existing === 'string' && existing.startsWith('<') && existing.endsWith('>');

  if (existing && !isPlaceholder && Buffer.byteLength(existing, 'utf8') >= 32) {
    console.log('A valid JWT_SECRET is already configured; it was left unchanged.');
  } else if (existing && !isPlaceholder) {
    console.error('JWT_SECRET is present but too short; it was left unchanged. Replace it locally or remove the empty setting, then retry.');
    process.exitCode = 1;
  } else {
    const secret = randomBytes(64).toString('base64url');
    const keyPattern = /^([ \t]*JWT_SECRET[ \t]*=).*$/gm;
    const updated = /^\s*JWT_SECRET\s*=/m.test(contents)
      ? contents.replace(keyPattern, `$1${secret}`)
      : `${contents}${contents.endsWith('\n') ? '' : '\n'}JWT_SECRET=${secret}\n`;
    if (updated !== contents) {
      await writeFile(envPath, updated, 'utf8');
    }
    console.log('Generated JWT_SECRET in the project root .env. Its value was not displayed.');
  }
} catch {
  console.error('Could not configure JWT_SECRET. Ensure the project root .env exists and is writable.');
  process.exitCode = 1;
}
