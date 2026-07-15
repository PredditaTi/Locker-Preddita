import assert from 'node:assert/strict';
import {
  adminUserCanAccessLocker,
  authenticateAdminUser,
  createAdminSessionStore,
  createPersistentAdminSessionStore,
  getAdminRolePermissions,
  hashAdminPassword,
  hashAdminSessionToken,
  parseAdminUsers,
  toPublicAdminSession,
  verifyAdminPassword,
} from '../admin-online/adminAuth.mjs';

const passwordHash = hashAdminPassword('senha-forte-de-teste', { salt: 'salt-admin-auth-test-001' });
assert.equal(verifyAdminPassword('senha-forte-de-teste', passwordHash), true);
assert.equal(verifyAdminPassword('senha-incorreta', passwordHash), false);
assert.equal(verifyAdminPassword('x'.repeat(10000), passwordHash), false);
assert.throws(() => hashAdminPassword('curta'));

const users = parseAdminUsers(JSON.stringify([
  {
    username: 'Operador.Teste',
    name: 'Operador Teste',
    role: 'operador',
    passwordHash,
    tenantId: 'tenant-teste',
    lockerIds: ['locker-01'],
  },
]), { defaultLockerId: 'locker-default', defaultTenantId: 'tenant-default' });

const user = authenticateAdminUser(users, 'operador.teste', 'senha-forte-de-teste');
assert.equal(user?.role, 'operador');
assert.equal(authenticateAdminUser(users, 'desconhecido', 'senha-forte-de-teste'), null);
assert.equal(adminUserCanAccessLocker(user, 'locker-01'), true);
assert.equal(adminUserCanAccessLocker(user, 'locker-02'), false);
assert.equal(adminUserCanAccessLocker(user, 'locker-01', 'tenant-teste'), true);
assert.equal(adminUserCanAccessLocker(user, 'locker-01', 'outro-tenant'), false);
assert.equal(getAdminRolePermissions('operador').canManageApartments, false);
assert.throws(() => parseAdminUsers(JSON.stringify([
  { username: 'global', role: 'sindico', passwordHash, lockerIds: ['*'] },
])));

const store = createAdminSessionStore({ ttlMs: 15 * 60 * 1000, secure: true });
const created = store.create(user);
assert.match(created.cookie, /HttpOnly/);
assert.match(created.cookie, /SameSite=Strict/);
assert.match(created.cookie, /Secure/);
const cookiePair = created.cookie.split(';')[0];
const restored = store.get(cookiePair);
assert.equal(restored?.user.username, 'operador.teste');
const publicSession = toPublicAdminSession(restored, { includeCsrf: true });
assert.equal(publicSession.csrfToken, restored.csrfToken);
assert.equal('passwordHash' in publicSession, false);
const clearedCookie = store.destroy(cookiePair);
assert.match(clearedCookie, /Max-Age=0/);
assert.equal(store.get(cookiePair), null);

const persistentRecords = new Map();
const persistentRepository = {
  async create(record) {
    persistentRecords.set(record.tokenHash, { ...record, revokedAt: '' });
  },
  async find(tokenHash) {
    return persistentRecords.get(tokenHash) || null;
  },
  async revoke(tokenHash, revokedAt) {
    const record = persistentRecords.get(tokenHash);
    if (record) persistentRecords.set(tokenHash, { ...record, revokedAt });
  },
  async prune() {},
  async size() {
    return persistentRecords.size;
  },
};
const persistentOptions = {
  ttlMs: 15 * 60 * 1000,
  secure: true,
  repository: persistentRepository,
  resolveUser: (username) => users.find((candidate) => candidate.username === username) || null,
};
const persistentStore = createPersistentAdminSessionStore(persistentOptions);
const persistentCreated = await persistentStore.create(user);
const persistentCookie = persistentCreated.cookie.split(';')[0];
const rawToken = decodeURIComponent(persistentCookie.split('=')[1]);
assert.equal(persistentRecords.has(rawToken), false, 'token bruto nao pode ser persistido');
assert.equal(persistentRecords.has(hashAdminSessionToken(rawToken)), true);

const restartedStore = createPersistentAdminSessionStore(persistentOptions);
const persistentRestored = await restartedStore.get(persistentCookie);
assert.equal(persistentRestored?.id, persistentCreated.session.id);
assert.equal(persistentRestored?.user.username, 'operador.teste');

await restartedStore.destroy(persistentCookie);
const restartedAfterLogout = createPersistentAdminSessionStore(persistentOptions);
assert.equal(await restartedAfterLogout.get(persistentCookie), null, 'logout deve continuar revogado apos restart');

console.log('PREDDITA_ADMIN_AUTH_OK');
