import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const ADMIN_SESSION_COOKIE = 'preddita_admin_session';
export const ADMIN_PASSWORD_HASH_PREFIX = 'scrypt-v1';
export const ADMIN_ROLES = new Set(['sindico', 'operador', 'suporte', 'super_admin']);

const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const DUMMY_PASSWORD_HASH = hashAdminPassword('preddita-invalid-password', {
  salt: 'preddita-auth-dummy-salt',
});

const ROLE_PERMISSIONS = Object.freeze({
  sindico: Object.freeze({
    canOperateLocker: true,
    canManageApartments: true,
    canViewPlatform: false,
    canViewSecurity: false,
    canViewOperationalLogs: false,
    canManageUpdates: false,
    canExportData: true,
    canViewPersonalData: true,
  }),
  operador: Object.freeze({
    canOperateLocker: true,
    canManageApartments: false,
    canViewPlatform: false,
    canViewSecurity: false,
    canViewOperationalLogs: false,
    canManageUpdates: false,
    canExportData: false,
    canViewPersonalData: false,
  }),
  suporte: Object.freeze({
    canOperateLocker: true,
    canManageApartments: false,
    canViewPlatform: true,
    canViewSecurity: true,
    canViewOperationalLogs: true,
    canManageUpdates: true,
    canExportData: false,
    canViewPersonalData: false,
  }),
  super_admin: Object.freeze({
    canOperateLocker: true,
    canManageApartments: true,
    canViewPlatform: true,
    canViewSecurity: true,
    canViewOperationalLogs: true,
    canManageUpdates: true,
    canExportData: true,
    canViewPersonalData: true,
  }),
});

function cleanText(value) {
  return String(value ?? '').trim();
}

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual ?? ''));
  const expectedBuffer = Buffer.from(String(expected ?? ''));
  return actualBuffer.length === expectedBuffer.length
    && expectedBuffer.length > 0
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function parsePasswordHash(encodedHash) {
  const [prefix, salt, digest, ...rest] = cleanText(encodedHash).split('$');
  if (
    rest.length > 0
    || prefix !== ADMIN_PASSWORD_HASH_PREFIX
    || !/^[A-Za-z0-9_-]{16,128}$/.test(salt || '')
    || !/^[A-Za-z0-9_-]{40,128}$/.test(digest || '')
  ) {
    return null;
  }
  return { salt, digest };
}

export function hashAdminPassword(password, options = {}) {
  const normalizedPassword = String(password ?? '');
  if (normalizedPassword.length < 12 || normalizedPassword.length > 256) {
    throw new Error('A senha administrativa deve ter entre 12 e 256 caracteres.');
  }
  const salt = cleanText(options.salt) || randomBytes(18).toString('base64url');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(salt)) {
    throw new Error('Salt scrypt invalido.');
  }
  const digest = scryptSync(normalizedPassword, salt, 32, SCRYPT_OPTIONS).toString('base64url');
  return `${ADMIN_PASSWORD_HASH_PREFIX}$${salt}$${digest}`;
}

export function verifyAdminPassword(password, encodedHash) {
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed) return false;
  const rawPassword = String(password ?? '');
  const validLength = rawPassword.length >= 1 && rawPassword.length <= 256;
  const candidatePassword = validLength ? rawPassword : 'preddita-invalid-password';
  const candidate = scryptSync(candidatePassword, parsed.salt, 32, SCRYPT_OPTIONS).toString('base64url');
  return validLength && safeEqual(candidate, parsed.digest);
}

export function getAdminRolePermissions(role) {
  const permissions = ROLE_PERMISSIONS[cleanText(role)];
  return permissions ? { ...permissions } : null;
}

function normalizeLockerIds(value, role, defaultLockerId) {
  const values = Array.isArray(value) ? value : [];
  const normalized = [...new Set(values.map(cleanText).filter(Boolean))];
  if (normalized.length > 0) return normalized;
  return role === 'super_admin' ? ['*'] : [defaultLockerId];
}

function normalizeAdminUser(rawUser, index, defaults) {
  const username = cleanText(rawUser?.username).toLowerCase();
  const role = cleanText(rawUser?.role);
  const passwordHash = cleanText(rawUser?.passwordHash);
  if (!/^[a-z0-9][a-z0-9._@-]{2,79}$/.test(username)) {
    throw new Error(`Usuario administrativo ${index + 1} possui username invalido.`);
  }
  if (!ADMIN_ROLES.has(role)) {
    throw new Error(`Usuario ${username} possui papel invalido.`);
  }
  if (!parsePasswordHash(passwordHash)) {
    throw new Error(`Usuario ${username} possui passwordHash invalido.`);
  }
  const lockerIds = normalizeLockerIds(rawUser?.lockerIds, role, defaults.defaultLockerId);
  if (lockerIds.includes('*') && !['super_admin', 'suporte'].includes(role)) {
    throw new Error(`Usuario ${username} nao pode acessar todos os lockers.`);
  }

  return Object.freeze({
    id: cleanText(rawUser?.id) || username,
    username,
    name: cleanText(rawUser?.name) || username,
    role,
    passwordHash,
    tenantId: cleanText(rawUser?.tenantId) || defaults.defaultTenantId,
    lockerIds: Object.freeze(lockerIds),
    disabled: Boolean(rawUser?.disabled),
    permissions: Object.freeze(getAdminRolePermissions(role)),
  });
}

export function parseAdminUsers(rawValue, options = {}) {
  const defaults = {
    defaultLockerId: cleanText(options.defaultLockerId) || 'ks1062-aurora',
    defaultTenantId: cleanText(options.defaultTenantId) || 'residencial-aurora',
  };
  const raw = cleanText(rawValue);
  let source;
  if (!raw) {
    if (!options.allowLocalDefaults) return [];
    source = [
      {
        username: 'sindico',
        name: 'Sindico Local',
        role: 'sindico',
        passwordHash: hashAdminPassword('preddita-admin-local'),
        lockerIds: [defaults.defaultLockerId],
      },
      {
        username: 'preddita',
        name: 'Admin PREDDITA Local',
        role: 'super_admin',
        passwordHash: hashAdminPassword('preddita-super-admin-local'),
        lockerIds: ['*'],
      },
    ];
  } else {
    try {
      source = JSON.parse(raw);
    } catch (error) {
      throw new Error(`PREDDITA_ADMIN_USERS deve ser um JSON valido: ${error.message}`);
    }
  }

  if (!Array.isArray(source) || source.length === 0 || source.length > 200) {
    throw new Error('PREDDITA_ADMIN_USERS deve conter de 1 a 200 usuarios.');
  }
  const users = source.map((user, index) => normalizeAdminUser(user, index, defaults));
  const usernames = new Set();
  for (const user of users) {
    if (usernames.has(user.username)) {
      throw new Error(`Username administrativo duplicado: ${user.username}.`);
    }
    usernames.add(user.username);
  }
  return users;
}

export function authenticateAdminUser(users, username, password) {
  const normalizedUsername = cleanText(username).toLowerCase();
  const user = users.find((candidate) => candidate.username === normalizedUsername && !candidate.disabled);
  const passwordHash = user?.passwordHash || DUMMY_PASSWORD_HASH;
  const valid = verifyAdminPassword(password, passwordHash);
  return user && valid ? user : null;
}

export function adminUserCanAccessLocker(user, lockerId, tenantId = '') {
  const normalizedLockerId = cleanText(lockerId);
  const normalizedTenantId = cleanText(tenantId);
  return Boolean(
    user
    && normalizedLockerId
    && (!normalizedTenantId || user.tenantId === normalizedTenantId)
    && (user.lockerIds.includes('*') || user.lockerIds.includes(normalizedLockerId))
  );
}

function readCookie(cookieHeader, name) {
  for (const part of String(cookieHeader ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return '';
}

function sessionCookie(token, options) {
  const parts = [
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${options.maxAgeSeconds}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function normalizeSessionOptions(options = {}) {
  return {
    ttlMs: Math.max(15 * 60 * 1000, Math.min(Number(options.ttlMs) || 8 * 60 * 60 * 1000, 24 * 60 * 60 * 1000)),
    maxSessions: Math.max(10, Math.min(Number(options.maxSessions) || 500, 5000)),
    secure: Boolean(options.secure),
  };
}

function createSession(user, ttlMs, now = Date.now()) {
  return Object.freeze({
    id: randomBytes(12).toString('base64url'),
    csrfToken: randomBytes(24).toString('base64url'),
    user,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    expiresAtMs: now + ttlMs,
  });
}

export function hashAdminSessionToken(token) {
  return createHash('sha256').update(String(token ?? '')).digest('hex');
}

export function createAdminSessionStore(options = {}) {
  const { ttlMs, maxSessions, secure } = normalizeSessionOptions(options);
  const sessions = new Map();

  function prune(now = Date.now()) {
    for (const [token, session] of sessions) {
      if (session.expiresAtMs <= now) sessions.delete(token);
    }
    while (sessions.size >= maxSessions) {
      const oldest = sessions.keys().next().value;
      if (!oldest) break;
      sessions.delete(oldest);
    }
  }

  function create(user) {
    const now = Date.now();
    prune(now);
    const token = randomBytes(32).toString('base64url');
    const session = createSession(user, ttlMs, now);
    sessions.set(token, session);
    return {
      session,
      cookie: sessionCookie(token, { secure, maxAgeSeconds: Math.floor(ttlMs / 1000) }),
    };
  }

  function get(cookieHeader) {
    const token = readCookie(cookieHeader, ADMIN_SESSION_COOKIE);
    if (!token) return null;
    const session = sessions.get(token) || null;
    if (!session) return null;
    if (session.expiresAtMs <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return session;
  }

  function destroy(cookieHeader) {
    const token = readCookie(cookieHeader, ADMIN_SESSION_COOKIE);
    if (token) sessions.delete(token);
    return sessionCookie('', { secure, maxAgeSeconds: 0 });
  }

  return Object.freeze({ create, get, destroy, size: () => sessions.size });
}

export function createPersistentAdminSessionStore(options = {}) {
  const { ttlMs, maxSessions, secure } = normalizeSessionOptions(options);
  const repository = options.repository;
  const resolveUser = options.resolveUser;
  if (
    !repository
    || typeof repository.create !== 'function'
    || typeof repository.find !== 'function'
    || typeof repository.revoke !== 'function'
    || typeof repository.prune !== 'function'
  ) {
    throw new Error('Repositorio persistente de sessoes administrativas invalido.');
  }
  if (typeof resolveUser !== 'function') {
    throw new Error('Resolvedor de usuario administrativo invalido.');
  }

  async function create(user) {
    const now = Date.now();
    await repository.prune(new Date(now).toISOString(), maxSessions);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashAdminSessionToken(token);
    const session = createSession(user, ttlMs, now);
    await repository.create({
      tokenHash,
      sessionId: session.id,
      username: user.username,
      csrfToken: session.csrfToken,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    });
    return {
      session,
      cookie: sessionCookie(token, { secure, maxAgeSeconds: Math.floor(ttlMs / 1000) }),
    };
  }

  async function get(cookieHeader) {
    const token = readCookie(cookieHeader, ADMIN_SESSION_COOKIE);
    if (!token) return null;
    const tokenHash = hashAdminSessionToken(token);
    const record = await repository.find(tokenHash);
    if (!record || record.revokedAt) return null;

    const expiresAtMs = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      await repository.revoke(tokenHash, new Date().toISOString());
      return null;
    }

    const user = await resolveUser(record.username);
    if (!user || user.disabled) {
      await repository.revoke(tokenHash, new Date().toISOString());
      return null;
    }

    return Object.freeze({
      id: record.sessionId,
      csrfToken: record.csrfToken,
      user,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      expiresAtMs,
    });
  }

  async function destroy(cookieHeader) {
    const token = readCookie(cookieHeader, ADMIN_SESSION_COOKIE);
    if (token) {
      await repository.revoke(hashAdminSessionToken(token), new Date().toISOString());
    }
    return sessionCookie('', { secure, maxAgeSeconds: 0 });
  }

  async function size() {
    return typeof repository.size === 'function' ? repository.size() : null;
  }

  return Object.freeze({ create, get, destroy, size });
}

export function toPublicAdminSession(session, options = {}) {
  if (!session?.user) return null;
  const user = session.user;
  return {
    id: session.id,
    username: user.username,
    name: user.name,
    role: user.role,
    label: user.name,
    tenantId: user.tenantId,
    lockerIds: [...user.lockerIds],
    ...user.permissions,
    permissions: { ...user.permissions },
    expiresAt: session.expiresAt,
    ...(options.includeCsrf ? { csrfToken: session.csrfToken } : {}),
  };
}
