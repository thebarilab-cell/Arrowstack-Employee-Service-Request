export function validateRuntimeConfig(environment = process.env) {
  const portValue = environment.PORT?.trim();
  const port = portValue ? Number(portValue) : 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  if (environment.NODE_ENV?.trim().toLowerCase() === 'production') {
    if (typeof environment.DATABASE_URL !== 'string' || environment.DATABASE_URL.length === 0) {
      throw new Error('DATABASE_URL must be configured in production.');
    }
    let databaseUrl;
    try { databaseUrl = new URL(environment.DATABASE_URL); } catch {
      throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
    }
    if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)
      || !databaseUrl.hostname
      || databaseUrl.pathname.length < 2) {
      throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
    }
    if (databaseUrl.searchParams.get('sslmode') !== 'verify-full') {
      throw new Error('Production DATABASE_URL must require PostgreSQL TLS certificate and hostname verification.');
    }
    const secret = environment.JWT_SECRET;
    if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32 || secret.includes('<') || secret.includes('>')) {
      throw new Error('JWT_SECRET must be a private value of at least 32 bytes in production.');
    }
  }

  return { port };
}
