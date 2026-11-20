export const LOCAL_EMPLOYEE_DATABASE = 'arrowstack_employee_service';

export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;

  // inet_server_addr() may include the host mask in PostgreSQL's text output.
  // Accept only full-host masks; broader CIDRs do not prove a loopback host.
  const normalized = address === '127.0.0.1/32'
    ? '127.0.0.1'
    : address === '::1/128' || address === '[::1]/128'
      ? '::1'
      : address;

  if (normalized === '::1' || normalized === '[::1]' || normalized === '::ffff:127.0.0.1') {
    return true;
  }

  const octets = normalized.split('.');
  return octets.length === 4
    && octets[0] === '127'
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

export function validateLocalResetTarget(connectionString, nodeEnvironment) {
  if (typeof connectionString !== 'string' || nodeEnvironment?.trim().toLowerCase() === 'production') {
    throw new Error('Password reset is restricted to the local development database.');
  }

  let target;
  try {
    target = new URL(connectionString);
  } catch {
    throw new Error('Password reset is restricted to the local development database.');
  }

  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  let databaseName;
  try {
    databaseName = decodeURIComponent(target.pathname.slice(1));
  } catch {
    throw new Error('Password reset is restricted to the local development database.');
  }

  if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !localHosts.has(target.hostname.toLowerCase())
    || (target.port !== '' && target.port !== '5432')
    || target.search !== ''
    || target.hash !== ''
    || databaseName !== LOCAL_EMPLOYEE_DATABASE) {
    throw new Error('Password reset is restricted to the local development database.');
  }

  return LOCAL_EMPLOYEE_DATABASE;
}

export function validateLocalStaffProvisionTarget(connectionString, nodeEnvironment) {
  try {
    return validateLocalResetTarget(connectionString, nodeEnvironment);
  } catch {
    throw new Error('Staff provisioning is restricted to the local development database.');
  }
}

export function validateConnectedDatabase(databaseName, serverAddress) {
  if (databaseName !== LOCAL_EMPLOYEE_DATABASE || !isLoopbackAddress(serverAddress)) {
    throw new Error('Connected PostgreSQL server is not the expected local development database.');
  }
}
