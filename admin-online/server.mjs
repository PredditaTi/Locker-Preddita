import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adminUserCanAccessLocker,
  authenticateAdminUser,
  createAdminSessionStore,
  createPersistentAdminSessionStore,
  getAdminRolePermissions,
  parseAdminUsers,
  toPublicAdminSession,
} from './adminAuth.mjs';
import {
  ADMIN_MFA_CHALLENGE_TTL_MS,
  ADMIN_MFA_MAX_ATTEMPTS,
  adminRoleRequiresMfa,
  createMfaChallengeToken,
  createTotpUri,
  decryptMfaSecret,
  encryptMfaSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashMfaChallengeToken,
  parseMfaEncryptionKey,
  verifyRecoveryCode,
  verifyTotp,
} from './adminMfa.mjs';
import {
  OPERATIONAL_SCHEMA_VERSION,
  ensureOperationalSchema,
  persistOperationalState,
  readOperationalState,
} from './operationalStore.mjs';
import {
  COMMAND_SCHEMA_VERSION,
  COMMAND_TRANSACTION_RETRY_ATTEMPTS,
  createOperationalCommand,
  ensureCommandSchema,
  leaseOperationalCommands,
  mutateOperationalCommand,
  reconcileOperationalCommand,
  refreshOperationalCommands,
} from './commandStore.mjs';

const ROOT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT_DIR, 'public');
const DATA_DIR = process.env.PREDDITA_DATA_DIR ? normalize(process.env.PREDDITA_DATA_DIR) : join(ROOT_DIR, 'data');
const DB_PATH = join(DATA_DIR, 'state.json');
const BACKUP_DIR = join(DATA_DIR, 'backups');
const APP_VERSION = '2.0.19-lab';
const SCHEMA_VERSION = 9;
const DEFAULT_ADMIN_TOKEN = 'preddita-admin-local';
const DEFAULT_SUPER_ADMIN_TOKEN = 'preddita-super-admin-local';
const DEFAULT_DEVICE_KEY = 'preddita-device-local';
const MAX_JSON_BODY_BYTES = 1_000_000;
const MAX_PROCESSED_DEVICE_EVENTS = 600;
const MAX_DEVICE_EVENTS_PER_BATCH = 120;
const MAX_NOTIFICATION_OUTBOX = 500;
const MAX_DELIVERY_EVIDENCE_DATA_URL = 900_000;
const DELIVERY_REMINDER_THRESHOLDS = [
  { level: 1, hours: 24, reason: 'delivery-reminder-24h' },
  { level: 2, hours: 48, reason: 'delivery-reminder-48h' },
  { level: 3, hours: 72, reason: 'delivery-reminder-72h' },
];

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);
const IS_PRODUCTION = String(process.env.NODE_ENV ?? '').toLowerCase() === 'production';
const ADMIN_TOKEN = process.env.PREDDITA_ADMIN_TOKEN ?? (IS_PRODUCTION ? '' : DEFAULT_ADMIN_TOKEN);
const SUPER_ADMIN_TOKEN = process.env.PREDDITA_SUPER_ADMIN_TOKEN ?? (IS_PRODUCTION ? '' : DEFAULT_SUPER_ADMIN_TOKEN);
const DEVICE_KEY = process.env.PREDDITA_DEVICE_KEY ?? (IS_PRODUCTION ? '' : DEFAULT_DEVICE_KEY);
const DEFAULT_TENANT_ID = process.env.PREDDITA_TENANT_ID ?? 'residencial-aurora';
const DEFAULT_LOCKER_ID = process.env.PREDDITA_LOCKER_ID ?? 'ks1062-aurora';
const DEVICE_KEYS = parseDeviceKeys(process.env.PREDDITA_DEVICE_KEYS, DEVICE_KEY);
const DEVICE_AUTH_MODES = new Set(['hmac', 'dual', 'legacy']);
const DEVICE_AUTH_MODE = cleanText(
  process.env.PREDDITA_DEVICE_AUTH_MODE || (IS_PRODUCTION ? 'hmac' : 'dual')
).toLowerCase();
const DEVICE_SIGNATURE_TTL_MS = Math.min(
  parsePositiveInteger(process.env.PREDDITA_DEVICE_SIGNATURE_TTL_MS, 120000),
  600000
);
const MAX_DEVICE_AUTH_NONCES = 5000;
const STORAGE_MODE = cleanText(process.env.PREDDITA_STORAGE || (process.env.PREDDITA_DATABASE_URL || process.env.DATABASE_URL ? 'postgres' : 'json')).toLowerCase();
const DATABASE_URL = cleanText(process.env.PREDDITA_DATABASE_URL || process.env.DATABASE_URL);
const COMMAND_TTL_MS = parsePositiveInteger(process.env.PREDDITA_COMMAND_TTL_MS, 120000);
const COMMAND_LEASE_MS = Math.min(
  parsePositiveInteger(process.env.PREDDITA_COMMAND_LEASE_MS, 15000),
  COMMAND_TTL_MS
);
const COMMAND_EXECUTION_LEASE_MS = Math.min(
  parsePositiveInteger(process.env.PREDDITA_COMMAND_EXECUTION_LEASE_MS, 30000),
  COMMAND_TTL_MS
);
const DEVICE_STALE_MS = Number.parseInt(process.env.PREDDITA_DEVICE_STALE_MS ?? '90000', 10);
const BACKUP_INTERVAL_MS = Number.parseInt(process.env.PREDDITA_BACKUP_INTERVAL_MS ?? '900000', 10);
const MAX_BACKUPS = Number.parseInt(process.env.PREDDITA_MAX_BACKUPS ?? '32', 10);
const ADMIN_RATE_LIMIT_PER_MINUTE = Number.parseInt(process.env.PREDDITA_ADMIN_RATE_LIMIT_PER_MINUTE ?? '180', 10);
const ADMIN_LOGIN_RATE_LIMIT_PER_MINUTE = parsePositiveInteger(process.env.PREDDITA_ADMIN_LOGIN_RATE_LIMIT_PER_MINUTE, 12);
const ADMIN_SESSION_TTL_MS = parsePositiveInteger(process.env.PREDDITA_ADMIN_SESSION_TTL_MS, 28800000);
const ADMIN_MFA_ENCRYPTION_KEY_VALUE = cleanText(process.env.PREDDITA_MFA_ENCRYPTION_KEY);
const ADMIN_MFA_ENCRYPTION_KEY = parseMfaEncryptionKey(ADMIN_MFA_ENCRYPTION_KEY_VALUE);
const DEVICE_RATE_LIMIT_PER_MINUTE = Number.parseInt(process.env.PREDDITA_DEVICE_RATE_LIMIT_PER_MINUTE ?? '240', 10);
const OPEN_RATE_LIMIT_PER_MINUTE = Number.parseInt(process.env.PREDDITA_OPEN_RATE_LIMIT_PER_MINUTE ?? '18', 10);
const NOTIFICATION_OUTBOX_INTERVAL_MS = Number.parseInt(process.env.PREDDITA_NOTIFICATION_OUTBOX_INTERVAL_MS ?? '30000', 10);
const NOTIFICATION_OUTBOX_MAX_ATTEMPTS = Number.parseInt(process.env.PREDDITA_NOTIFICATION_OUTBOX_MAX_ATTEMPTS ?? '8', 10);
const TRUST_PROXY = String(process.env.PREDDITA_TRUST_PROXY ?? 'false').toLowerCase() === 'true';
const ALLOWED_ORIGINS = cleanText(process.env.PREDDITA_ALLOWED_ORIGINS)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const SMTP_HOST = cleanText(process.env.PREDDITA_SMTP_HOST);
const SMTP_PORT = Number.parseInt(process.env.PREDDITA_SMTP_PORT ?? (process.env.PREDDITA_SMTP_SECURE === 'true' ? '465' : '587'), 10);
const SMTP_SECURE = String(process.env.PREDDITA_SMTP_SECURE ?? 'false').toLowerCase() === 'true';
const SMTP_USER = cleanText(process.env.PREDDITA_SMTP_USER);
const SMTP_PASS = cleanText(process.env.PREDDITA_SMTP_PASS);
const SMTP_FROM = cleanText(process.env.PREDDITA_SMTP_FROM || process.env.PREDDITA_SMTP_USER);
const ALLOW_LEGACY_ADMIN_TOKENS = !IS_PRODUCTION
  && String(process.env.PREDDITA_LEGACY_ADMIN_TOKENS ?? 'false').toLowerCase() === 'true';
const ADMIN_USERS_BOOTSTRAP_CONFIGURED = Boolean(cleanText(process.env.PREDDITA_ADMIN_USERS));
let adminUsers = [];
let adminUsersConfigError = '';
try {
  adminUsers = parseAdminUsers(process.env.PREDDITA_ADMIN_USERS, {
    defaultLockerId: DEFAULT_LOCKER_ID,
    defaultTenantId: DEFAULT_TENANT_ID,
    allowLocalDefaults: !IS_PRODUCTION,
  });
} catch (error) {
  adminUsersConfigError = error.message;
}
let adminSessionStore = createAdminSessionStore({
  ttlMs: ADMIN_SESSION_TTL_MS,
  secure: IS_PRODUCTION,
});
let lastBackupAt = 0;
let notificationOutboxInFlight = false;
let postgresPool = null;
let postgresReadyPromise = null;
const lockerStateMutationQueues = new Map();
const deviceAuthNonces = new Map();

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseJsonDocument(rawValue) {
  return JSON.parse(String(rawValue ?? '').replace(/^\uFEFF/, ''));
}

function stateReadError(path, error) {
  const detail = cleanText(error?.message) || 'JSON invalido.';
  return new Error(`Estado JSON invalido em ${path}. O arquivo foi preservado e precisa ser recuperado antes de iniciar a operacao. ${detail}`);
}

function normalizeImageDataUrl(value) {
  const text = cleanText(value);
  if (!/^data:image\/(?:jpeg|jpg|png|webp);base64,/i.test(text)) return '';
  if (text.length > MAX_DELIVERY_EVIDENCE_DATA_URL) return '';
  return text;
}

function parseDateMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getDeliveryStoredAtMs(delivery = {}) {
  return parseDateMs(delivery.depositedAt) ?? parseDateMs(delivery.createdAt);
}

function getStoredDeliveryAgeHours(delivery = {}, nowMs = Date.now()) {
  if (cleanText(delivery.status) !== 'stored') return 0;
  const storedAt = getDeliveryStoredAtMs(delivery);
  if (!Number.isFinite(storedAt)) return 0;
  return Math.max(0, (nowMs - storedAt) / 3_600_000);
}

function getDeliveryReminderDue(delivery = {}, nowMs = Date.now()) {
  if (cleanText(delivery.status) !== 'stored') return null;

  const ageHours = getStoredDeliveryAgeHours(delivery, nowMs);
  const currentLevel = Number.isFinite(Number(delivery.reminderLevel))
    ? Math.max(0, Number(delivery.reminderLevel))
    : 0;
  const dueThreshold = DELIVERY_REMINDER_THRESHOLDS
    .filter((threshold) => ageHours >= threshold.hours && threshold.level > currentLevel)
    .at(-1);

  return dueThreshold ? { ...dueThreshold, ageHours } : null;
}

function isReminderReason(reason) {
  return /^delivery-reminder-\d+h$/.test(cleanText(reason));
}

function reminderLevelFromReason(reason) {
  const match = cleanText(reason).match(/delivery-reminder-(\d+)h/);
  const hours = match ? Number.parseInt(match[1], 10) : 0;
  const threshold = DELIVERY_REMINDER_THRESHOLDS.find((item) => item.hours === hours);
  return threshold?.level ?? 0;
}

function isPostgresStorage() {
  return STORAGE_MODE === 'postgres';
}

function normalizeTenantId(value) {
  return cleanText(value) || DEFAULT_TENANT_ID;
}

function normalizeLockerId(value) {
  return cleanText(value) || DEFAULT_LOCKER_ID;
}

function parseDeviceKeys(rawValue, legacyKey) {
  const keys = new Map();
  const defaultLocker = cleanText(DEFAULT_LOCKER_ID);
  const fallbackKey = cleanText(legacyKey);
  if (defaultLocker && fallbackKey) {
    keys.set(defaultLocker, fallbackKey);
  }

  const raw = cleanText(rawValue);
  if (!raw) {
    return keys;
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [lockerId, key] of Object.entries(parsed)) {
        const normalizedLockerId = cleanText(lockerId);
        const normalizedKey = cleanText(key);
        if (normalizedLockerId && normalizedKey) keys.set(normalizedLockerId, normalizedKey);
      }
      return keys;
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const normalizedLockerId = cleanText(item?.lockerId ?? item?.id);
        const normalizedKey = cleanText(item?.key ?? item?.deviceKey);
        if (normalizedLockerId && normalizedKey) keys.set(normalizedLockerId, normalizedKey);
      }
      return keys;
    }
  } catch (_error) {
  }

  for (const entry of raw.split(',')) {
    const [lockerId, key] = entry.split(/[:=]/);
    const normalizedLockerId = cleanText(lockerId);
    const normalizedKey = cleanText(key);
    if (normalizedLockerId && normalizedKey) keys.set(normalizedLockerId, normalizedKey);
  }

  return keys;
}

function getStartupConfigErrors() {
  const errors = [];
  if (adminUsersConfigError) {
    errors.push(adminUsersConfigError);
  }
  if (!DEVICE_AUTH_MODES.has(DEVICE_AUTH_MODE)) {
    errors.push('PREDDITA_DEVICE_AUTH_MODE deve ser hmac, dual ou legacy.');
  }
  if (ADMIN_MFA_ENCRYPTION_KEY_VALUE && !ADMIN_MFA_ENCRYPTION_KEY) {
    errors.push('PREDDITA_MFA_ENCRYPTION_KEY deve conter exatamente 32 bytes em Base64.');
  }
  if (IS_PRODUCTION && DEVICE_AUTH_MODE !== 'hmac') {
    errors.push('PREDDITA_DEVICE_AUTH_MODE deve ser hmac em producao.');
  }
  if (!IS_PRODUCTION) {
    return errors;
  }

  if (adminUsers.length === 0 && !isPostgresStorage()) {
    errors.push('PREDDITA_ADMIN_USERS deve definir usuarios com passwordHash em producao.');
  } else if (adminUsers.length > 0 && !adminUsers.some((user) => user.role === 'super_admin' && !user.disabled)) {
    errors.push('PREDDITA_ADMIN_USERS deve conter ao menos um super_admin ativo.');
  }
  if (String(process.env.PREDDITA_LEGACY_ADMIN_TOKENS ?? '').toLowerCase() === 'true') {
    errors.push('PREDDITA_LEGACY_ADMIN_TOKENS nao pode ser habilitado em producao.');
  }

  if (DEVICE_KEYS.size === 0) {
    errors.push('PREDDITA_DEVICE_KEY ou PREDDITA_DEVICE_KEYS deve ser definido em producao.');
  }
  if ([...DEVICE_KEYS.values()].some((key) => key === DEFAULT_DEVICE_KEY)) {
    errors.push('Chaves de dispositivo nao podem usar o valor local padrao em producao.');
  }

  if (ALLOWED_ORIGINS.length === 0) {
    errors.push('PREDDITA_ALLOWED_ORIGINS deve ser definido em producao.');
  }

  if (isPostgresStorage() && !DATABASE_URL) {
    errors.push('PREDDITA_DATABASE_URL ou DATABASE_URL deve ser definido quando PREDDITA_STORAGE=postgres.');
  }
  if (!isPostgresStorage()) {
    errors.push('PREDDITA_STORAGE deve ser postgres em producao para proteger contas privilegiadas com MFA.');
  }
  if (!ADMIN_MFA_ENCRYPTION_KEY) {
    errors.push('PREDDITA_MFA_ENCRYPTION_KEY deve ser definido em producao para proteger os segredos MFA.');
  }

  return errors;
}

function normalizeToken(value) {
  return Buffer.from(cleanText(value));
}

function safeTokenEquals(actual, expected) {
  const actualBuffer = normalizeToken(actual);
  const expectedBuffer = normalizeToken(expected);
  if (actualBuffer.length !== expectedBuffer.length || expectedBuffer.length === 0) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function normalizeCpf(value) {
  return cleanText(value).replace(/[^\d.-]/g, '');
}

function escapeHtml(value) {
  return cleanText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanText(value));
}

function doorSizeForChannel(channel) {
  const number = Number.parseInt(channel, 10);
  return number === 1 || number === 2 ? 'G' : 'P';
}

function normalizeDoorSize(value, channel) {
  const size = cleanText(value).toUpperCase();
  return ['P', 'M', 'G'].includes(size) ? size : doorSizeForChannel(channel);
}

function isActiveDeliveryStatus(status) {
  return ['door_opened_for_dropoff', 'stored', 'pickup_opened'].includes(cleanText(status));
}

function createDoors(count = 24) {
  return Array.from({ length: count }, (_, index) => ({
    channel: index + 1,
    label: `Porta ${index + 1}`,
    size: doorSizeForChannel(index + 1),
    status: 'unknown',
    occupancy: 'free',
    lastSeenAt: '',
  }));
}

function residentApartmentLabel(resident = {}) {
  const apartment = cleanText(resident.apartment);
  return apartment ? `Apartamento ${apartment}` : 'Apartamento sem numero';
}

function residentUnitLabel(resident = {}) {
  const building = cleanText(resident.building);
  const floor = cleanText(resident.floor);
  const apartment = cleanText(resident.apartment);
  const parts = [];

  if (building) parts.push(building);
  if (floor) parts.push(`${floor} andar`);
  if (apartment) parts.push(`Ap ${apartment}`);

  return parts.length ? parts.join(' - ') : residentApartmentLabel(resident);
}

function normalizeResidentRecord(resident = {}) {
  return {
    id: cleanText(resident.id) || createId('unit'),
    firstName: '',
    lastName: '',
    phone: cleanText(resident.phone),
    email: cleanText(resident.email).toLowerCase(),
    cpf: '',
    floor: cleanText(resident.floor),
    apartment: cleanText(resident.apartment),
    building: cleanText(resident.building) || 'Torre A',
    createdAt: cleanText(resident.createdAt) || nowIso(),
    updatedAt: cleanText(resident.updatedAt) || nowIso(),
  };
}

function createInitialState(options = {}) {
  const createdAt = nowIso();
  const tenantId = normalizeTenantId(options.tenantId);
  const lockerId = normalizeLockerId(options.lockerId);
  return {
    schemaVersion: SCHEMA_VERSION,
    tenant: {
      tenantId,
      siteName: 'Residencial Aurora',
      lockerId,
      lockerName: 'Locker Entregas Torre Norte',
    },
    device: {
      lockerId,
      online: false,
      serialOpen: false,
      serialPath: '',
      bridgeVersion: '',
      lastSeenAt: '',
      doorCount: 24,
      board: 1,
    },
    residents: [
      {
        id: 'unit-torre-a-203',
        firstName: '',
        lastName: '',
        phone: '(11) 98741-2201',
        email: 'aline.sousa@example.com',
        cpf: '',
        floor: '2',
        apartment: '203',
        building: 'Torre A',
        createdAt,
        updatedAt: createdAt,
      },
    ],
    residentsUpdatedAt: createdAt,
    doors: createDoors(24),
    deliveries: [],
    notificationOutbox: [],
    commands: [],
    processedDeviceEvents: [],
    auditTrail: [
      {
        id: createId('audit'),
        kind: 'boot',
        message: 'Admin online inicializado.',
        at: createdAt,
      },
    ],
    updatedAt: createdAt,
  };
}

function normalizeDoorRecord(door, fallbackDoor) {
  const channel = Number.parseInt(door?.channel ?? fallbackDoor.channel, 10);
  const safeChannel = Number.isFinite(channel) ? channel : fallbackDoor.channel;
  return {
    ...fallbackDoor,
    ...door,
    channel: safeChannel,
    label: cleanText(door?.label) || fallbackDoor.label,
    size: normalizeDoorSize(door?.size, safeChannel),
    status: cleanText(door?.status) || fallbackDoor.status,
    occupancy: cleanText(door?.occupancy) || fallbackDoor.occupancy,
    lastSeenAt: cleanText(door?.lastSeenAt),
  };
}

function normalizeCommandRecord(command = {}) {
  const incomingStatus = cleanText(command.status) || 'pending';
  const migratedLegacySent = incomingStatus === 'sent';
  const status = migratedLegacySent ? 'failed' : incomingStatus;
  const migrationAt = cleanText(command.sentAt || command.createdAt || command.completedAt);
  const timeline = Array.isArray(command.timeline) ? command.timeline : [];
  const hasLegacyMigration = timeline.some((item) => item?.status === 'legacy-sent-unknown');

  return {
    ...command,
    status,
    leaseId: cleanText(command.leaseId),
    leasedAt: cleanText(command.leasedAt),
    leaseExpiresAt: cleanText(command.leaseExpiresAt),
    acknowledgedAt: cleanText(command.acknowledgedAt),
    executionId: cleanText(command.executionId),
    deliveryAttempt: Math.max(0, Number.parseInt(command.deliveryAttempt, 10) || 0),
    completedAt: migratedLegacySent
      ? cleanText(command.completedAt) || migrationAt
      : cleanText(command.completedAt),
    result: migratedLegacySent
      ? command.result ?? {
          ok: false,
          error: 'Comando legado foi entregue sem ACK; resultado fisico desconhecido.',
          legacyDeliveryUnknown: true,
        }
      : command.result ?? null,
    timeline: migratedLegacySent && !hasLegacyMigration
      ? [
          ...timeline,
          {
            status: 'legacy-sent-unknown',
            at: migrationAt,
            detail: 'Comando legado encerrado sem reexecucao automatica por falta de ACK.',
          },
        ]
      : timeline,
  };
}

function migrateState(parsed = {}, options = {}) {
  const fallback = createInitialState({
    tenantId: parsed.tenant?.tenantId ?? options.tenantId,
    lockerId: parsed.tenant?.lockerId ?? parsed.device?.lockerId ?? options.lockerId,
  });
  const doorCount = Math.max(
    1,
    Math.min(
      64,
      Number.parseInt(parsed.device?.doorCount ?? parsed.doors?.length ?? fallback.device.doorCount, 10) || fallback.device.doorCount
    )
  );
  const fallbackDoors = createDoors(doorCount);
  const incomingDoors = Array.isArray(parsed.doors) ? parsed.doors : [];

  return {
    ...fallback,
    ...parsed,
    schemaVersion: SCHEMA_VERSION,
    tenant: parsed.tenant && typeof parsed.tenant === 'object'
      ? {
          ...fallback.tenant,
          ...parsed.tenant,
          tenantId: normalizeTenantId(parsed.tenant.tenantId ?? options.tenantId),
          lockerId: normalizeLockerId(parsed.tenant.lockerId ?? options.lockerId),
        }
      : fallback.tenant,
    device: parsed.device && typeof parsed.device === 'object'
      ? {
          ...fallback.device,
          ...parsed.device,
          lockerId: normalizeLockerId(parsed.device.lockerId ?? parsed.tenant?.lockerId ?? options.lockerId),
          doorCount,
        }
      : { ...fallback.device, doorCount },
    residents: Array.isArray(parsed.residents)
      ? parsed.residents.map(normalizeResidentRecord)
      : fallback.residents.map(normalizeResidentRecord),
    residentsUpdatedAt: parsed.residentsUpdatedAt ?? parsed.updatedAt ?? fallback.residentsUpdatedAt,
    doors: fallbackDoors.map((fallbackDoor, index) => normalizeDoorRecord(incomingDoors[index], fallbackDoor)),
    deliveries: Array.isArray(parsed.deliveries) ? parsed.deliveries : fallback.deliveries,
    notificationOutbox: Array.isArray(parsed.notificationOutbox)
      ? parsed.notificationOutbox.map(normalizeNotificationOutboxItem).slice(0, MAX_NOTIFICATION_OUTBOX)
      : [],
    commands: Array.isArray(parsed.commands) ? parsed.commands.map(normalizeCommandRecord) : [],
    processedDeviceEvents: Array.isArray(parsed.processedDeviceEvents)
      ? parsed.processedDeviceEvents.slice(0, MAX_PROCESSED_DEVICE_EVENTS)
      : [],
    auditTrail: Array.isArray(parsed.auditTrail) ? parsed.auditTrail : fallback.auditTrail,
    updatedAt: cleanText(parsed.updatedAt) || fallback.updatedAt,
  };
}

function ensureDb() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  if (!existsSync(DB_PATH)) writeFileSync(DB_PATH, JSON.stringify(createInitialState(), null, 2));
}

async function ensurePostgres() {
  if (!isPostgresStorage()) return null;
  if (!DATABASE_URL) {
    throw new Error('PREDDITA_DATABASE_URL ou DATABASE_URL nao foi configurado.');
  }
  if (postgresReadyPromise) return postgresReadyPromise;

  postgresReadyPromise = (async () => {
    const pgModule = await import('pg');
    const Pool = pgModule.Pool ?? pgModule.default?.Pool;
    postgresPool = new Pool({ connectionString: DATABASE_URL });
    await postgresPool.query(`
      create table if not exists preddita_locker_states (
        tenant_id text not null,
        locker_id text not null,
        schema_version integer not null,
        state jsonb not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (tenant_id, locker_id)
      )
    `);
    await postgresPool.query(`
      create index if not exists idx_preddita_locker_states_updated_at
      on preddita_locker_states (updated_at desc)
    `);
    await ensureOperationalSchema(postgresPool);
    await ensureCommandSchema(postgresPool);
    await postgresPool.query(`
      create table if not exists preddita_admin_users (
        username text primary key,
        user_id text not null,
        name text not null,
        role text not null,
        password_hash text not null,
        tenant_id text not null,
        locker_ids jsonb not null,
        disabled boolean not null default false,
        source text not null default 'environment',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await postgresPool.query(`
      create index if not exists idx_preddita_admin_users_tenant
      on preddita_admin_users (tenant_id, disabled, role)
    `);
    await postgresPool.query(`
      create table if not exists preddita_admin_sessions (
        token_hash char(64) primary key,
        session_id text not null unique,
        username text not null references preddita_admin_users(username),
        csrf_token text not null,
        created_at timestamptz not null,
        expires_at timestamptz not null,
        last_seen_at timestamptz not null default now(),
        revoked_at timestamptz
      )
    `);
    await postgresPool.query(`
      create index if not exists idx_preddita_admin_sessions_active
      on preddita_admin_sessions (username, expires_at desc)
      where revoked_at is null
    `);
    await postgresPool.query(`
      create table if not exists preddita_admin_mfa (
        username text primary key references preddita_admin_users(username),
        secret_ciphertext text not null,
        last_used_step bigint not null default -1,
        recovery_codes jsonb not null default '[]'::jsonb,
        enabled_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await postgresPool.query(`
      create table if not exists preddita_admin_mfa_challenges (
        token_hash char(64) primary key,
        username text not null references preddita_admin_users(username),
        kind text not null check (kind in ('enroll', 'verify')),
        pending_secret_ciphertext text,
        attempts integer not null default 0 check (attempts >= 0),
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        consumed_at timestamptz
      )
    `);
    await postgresPool.query(`
      create index if not exists idx_preddita_admin_mfa_challenges_active
      on preddita_admin_mfa_challenges (username, expires_at desc)
      where consumed_at is null
    `);
    return postgresPool;
  })();

  return postgresReadyPromise;
}

async function syncPostgresAdminUsers(users) {
  const pool = await ensurePostgres();
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const user of users) {
      const changedResult = await client.query(
        `
          select exists (
            select 1
            from preddita_admin_users
            where username = $1
              and (
                password_hash <> $2
                or role <> $3
                or tenant_id <> $4
                or locker_ids <> $5::jsonb
                or disabled <> $6
              )
          ) as changed
        `,
        [
          user.username,
          user.passwordHash,
          user.role,
          user.tenantId,
          JSON.stringify(user.lockerIds),
          user.disabled,
        ]
      );
      await client.query(
        `
          insert into preddita_admin_users (
            username, user_id, name, role, password_hash, tenant_id,
            locker_ids, disabled, source, updated_at
          ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'environment', now())
          on conflict (username)
          do update set
            user_id = excluded.user_id,
            name = excluded.name,
            role = excluded.role,
            password_hash = excluded.password_hash,
            tenant_id = excluded.tenant_id,
            locker_ids = excluded.locker_ids,
            disabled = excluded.disabled,
            source = 'environment',
            updated_at = now()
        `,
        [
          user.username,
          user.id,
          user.name,
          user.role,
          user.passwordHash,
          user.tenantId,
          JSON.stringify(user.lockerIds),
          user.disabled,
        ]
      );
      if (changedResult.rows[0]?.changed) {
        await client.query(
          `
            update preddita_admin_sessions
            set revoked_at = coalesce(revoked_at, now())
            where username = $1 and revoked_at is null
          `,
          [user.username]
        );
      }
    }
    const activeUsernames = users.map((user) => user.username);
    const removedResult = await client.query(
      `
        update preddita_admin_users
        set disabled = true, updated_at = now()
        where source = 'environment'
          and not (username = any($1::text[]))
          and disabled = false
        returning username
      `,
      [activeUsernames]
    );
    const removedUsernames = removedResult.rows.map((row) => row.username);
    if (removedUsernames.length > 0) {
      await client.query(
        `
          update preddita_admin_sessions
          set revoked_at = coalesce(revoked_at, now())
          where username = any($1::text[]) and revoked_at is null
        `,
        [removedUsernames]
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function readPostgresAdminUsers() {
  const pool = await ensurePostgres();
  const result = await pool.query(`
    select username, user_id, name, role, password_hash, tenant_id, locker_ids, disabled
    from preddita_admin_users
    where disabled = false
    order by username
  `);
  const rawUsers = result.rows.map((row) => ({
    id: row.user_id,
    username: row.username,
    name: row.name,
    role: row.role,
    passwordHash: row.password_hash,
    tenantId: row.tenant_id,
    lockerIds: row.locker_ids,
    disabled: row.disabled,
  }));
  if (rawUsers.length === 0) return [];
  return parseAdminUsers(JSON.stringify(rawUsers), {
    defaultLockerId: DEFAULT_LOCKER_ID,
    defaultTenantId: DEFAULT_TENANT_ID,
    allowLocalDefaults: false,
  });
}

function createPostgresAdminSessionRepository() {
  return {
    async create(record) {
      const pool = await ensurePostgres();
      await pool.query(
        `
          insert into preddita_admin_sessions (
            token_hash, session_id, username, csrf_token, created_at, expires_at, last_seen_at
          ) values ($1, $2, $3, $4, $5, $6, now())
        `,
        [
          record.tokenHash,
          record.sessionId,
          record.username,
          record.csrfToken,
          record.createdAt,
          record.expiresAt,
        ]
      );
    },
    async find(tokenHash) {
      const pool = await ensurePostgres();
      const result = await pool.query(
        `
          update preddita_admin_sessions
          set last_seen_at = now()
          where token_hash = $1
          returning
            session_id, username, csrf_token, created_at, expires_at, revoked_at
        `,
        [tokenHash]
      );
      const row = result.rows[0];
      return row ? {
        sessionId: row.session_id,
        username: row.username,
        csrfToken: row.csrf_token,
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        revokedAt: row.revoked_at?.toISOString() || '',
      } : null;
    },
    async revoke(tokenHash, revokedAt) {
      const pool = await ensurePostgres();
      await pool.query(
        `
          update preddita_admin_sessions
          set revoked_at = coalesce(revoked_at, $2::timestamptz), last_seen_at = now()
          where token_hash = $1
        `,
        [tokenHash, revokedAt]
      );
    },
    async prune(now, maxSessions) {
      const pool = await ensurePostgres();
      await pool.query('delete from preddita_admin_sessions where expires_at <= $1::timestamptz', [now]);
      const countResult = await pool.query('select count(*)::integer as count from preddita_admin_sessions');
      const excess = Math.max(0, Number(countResult.rows[0]?.count || 0) - maxSessions + 1);
      if (excess > 0) {
        await pool.query(
          `
            delete from preddita_admin_sessions
            where token_hash in (
              select token_hash
              from preddita_admin_sessions
              order by revoked_at nulls last, created_at asc
              limit $1
            )
          `,
          [excess]
        );
      }
    },
    async size() {
      const pool = await ensurePostgres();
      const result = await pool.query('select count(*)::integer as count from preddita_admin_sessions');
      return Number(result.rows[0]?.count || 0);
    },
  };
}

async function initializePostgresAdminAuth() {
  if (ADMIN_USERS_BOOTSTRAP_CONFIGURED) {
    await syncPostgresAdminUsers(adminUsers);
  }
  let persistedUsers = await readPostgresAdminUsers();
  if (persistedUsers.length === 0 && !IS_PRODUCTION && adminUsers.length > 0) {
    await syncPostgresAdminUsers(adminUsers);
    persistedUsers = await readPostgresAdminUsers();
  }
  adminUsers = persistedUsers;
  if (adminUsers.length === 0) {
    throw new Error('Nenhum usuario administrativo foi encontrado no Postgres. Configure PREDDITA_ADMIN_USERS no primeiro boot.');
  }
  if (!adminUsers.some((user) => user.role === 'super_admin' && !user.disabled)) {
    throw new Error('O Postgres deve conter ao menos um super_admin ativo.');
  }
  adminSessionStore = createPersistentAdminSessionStore({
    ttlMs: ADMIN_SESSION_TTL_MS,
    secure: IS_PRODUCTION,
    repository: createPostgresAdminSessionRepository(),
    resolveUser: (username) => adminUsers.find((user) => user.username === username) || null,
  });
}

function isAdminMfaEnabledFor(user) {
  return Boolean(
    user
    && isPostgresStorage()
    && ADMIN_MFA_ENCRYPTION_KEY
    && adminRoleRequiresMfa(user.role)
  );
}

async function readPostgresAdminMfa(username) {
  const pool = await ensurePostgres();
  const result = await pool.query(
    'select username from preddita_admin_mfa where username = $1',
    [username]
  );
  return Boolean(result.rows[0]);
}

async function createPostgresAdminMfaChallenge(user, options = {}) {
  const pool = await ensurePostgres();
  const token = createMfaChallengeToken();
  const tokenHash = hashMfaChallengeToken(token);
  const expiresAt = new Date(Date.now() + ADMIN_MFA_CHALLENGE_TTL_MS).toISOString();
  const kind = options.secretCiphertext ? 'enroll' : 'verify';
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `
        update preddita_admin_mfa_challenges
        set consumed_at = coalesce(consumed_at, now())
        where username = $1 and consumed_at is null
      `,
      [user.username]
    );
    await client.query(
      `
        insert into preddita_admin_mfa_challenges (
          token_hash, username, kind, pending_secret_ciphertext, expires_at
        ) values ($1, $2, $3, $4, $5)
      `,
      [tokenHash, user.username, kind, options.secretCiphertext || null, expiresAt]
    );
    await client.query("delete from preddita_admin_mfa_challenges where expires_at < now() - interval '1 day'");
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  return { token, kind, expiresAt };
}

async function buildAdminMfaQrDataUrl(otpauthUri) {
  const qrModule = await import('qrcode');
  const QRCode = qrModule.default ?? qrModule;
  return QRCode.toDataURL(otpauthUri, {
    margin: 1,
    width: 256,
    errorCorrectionLevel: 'M',
    color: { dark: '#10263a', light: '#ffffff' },
  });
}

async function beginAdminMfaLogin(user) {
  const enrolled = await readPostgresAdminMfa(user.username);
  if (enrolled) {
    const challenge = await createPostgresAdminMfaChallenge(user);
    return {
      required: true,
      enrollment: false,
      challengeToken: challenge.token,
      expiresAt: challenge.expiresAt,
    };
  }

  const secret = generateTotpSecret();
  const secretCiphertext = encryptMfaSecret(secret, ADMIN_MFA_ENCRYPTION_KEY);
  const challenge = await createPostgresAdminMfaChallenge(user, { secretCiphertext });
  const otpauthUri = createTotpUri({ secret, username: user.username });
  return {
    required: true,
    enrollment: true,
    challengeToken: challenge.token,
    expiresAt: challenge.expiresAt,
    secret,
    otpauthUri,
    qrDataUrl: await buildAdminMfaQrDataUrl(otpauthUri),
  };
}

async function completeAdminMfaLogin({ challengeToken, code, recoveryCode }) {
  const tokenHash = hashMfaChallengeToken(challengeToken);
  const pool = await ensurePostgres();
  const client = await pool.connect();
  try {
    await client.query('begin');
    const challengeResult = await client.query(
      `
        select token_hash, username, kind, pending_secret_ciphertext, attempts
        from preddita_admin_mfa_challenges
        where token_hash = $1 and consumed_at is null and expires_at > now()
        for update
      `,
      [tokenHash]
    );
    const challenge = challengeResult.rows[0];
    if (!challenge || challenge.attempts >= ADMIN_MFA_MAX_ATTEMPTS) {
      await client.query('commit');
      return { ok: false, status: 401, error: 'Desafio MFA invalido ou expirado. Entre novamente.' };
    }

    const user = adminUsers.find((candidate) => candidate.username === challenge.username && !candidate.disabled);
    if (!user || !adminRoleRequiresMfa(user.role)) {
      await client.query(
        'update preddita_admin_mfa_challenges set consumed_at = now() where token_hash = $1',
        [tokenHash]
      );
      await client.query('commit');
      return { ok: false, status: 401, error: 'Desafio MFA invalido ou expirado. Entre novamente.' };
    }

    const attempts = Number(challenge.attempts) + 1;
    await client.query(
      `
        update preddita_admin_mfa_challenges
        set attempts = $2::integer,
            consumed_at = case when $2::integer >= $3::integer then now() else consumed_at end
        where token_hash = $1
      `,
      [tokenHash, attempts, ADMIN_MFA_MAX_ATTEMPTS]
    );

    const mfaResult = await client.query(
      `
        select secret_ciphertext, last_used_step, recovery_codes
        from preddita_admin_mfa
        where username = $1
        for update
      `,
      [user.username]
    );
    const mfa = mfaResult.rows[0];

    if (challenge.kind === 'enroll') {
      if (mfa || !challenge.pending_secret_ciphertext || recoveryCode) {
        await client.query('commit');
        return { ok: false, status: 409, error: 'O cadastro MFA mudou. Entre novamente.' };
      }
      const secret = decryptMfaSecret(challenge.pending_secret_ciphertext, ADMIN_MFA_ENCRYPTION_KEY);
      const verified = verifyTotp(secret, code, { window: 1 });
      if (!verified) {
        await client.query('commit');
        return { ok: false, status: 401, error: 'Codigo invalido. Confira o horario do autenticador e tente novamente.' };
      }
      const recovery = generateRecoveryCodes();
      await client.query(
        `
          insert into preddita_admin_mfa (
            username, secret_ciphertext, last_used_step, recovery_codes, enabled_at, updated_at
          ) values ($1, $2, $3, $4::jsonb, now(), now())
        `,
        [user.username, challenge.pending_secret_ciphertext, verified.counter, JSON.stringify(recovery.records)]
      );
      await client.query(
        'update preddita_admin_sessions set revoked_at = coalesce(revoked_at, now()) where username = $1',
        [user.username]
      );
      await client.query(
        'update preddita_admin_mfa_challenges set consumed_at = now() where token_hash = $1',
        [tokenHash]
      );
      await client.query('commit');
      return { ok: true, user, enrollment: true, recoveryCodes: recovery.codes };
    }

    if (!mfa || challenge.kind !== 'verify') {
      await client.query('commit');
      return { ok: false, status: 409, error: 'A configuracao MFA mudou. Entre novamente.' };
    }

    if (recoveryCode) {
      const records = Array.isArray(mfa.recovery_codes) ? mfa.recovery_codes : [];
      const matchedRecord = verifyRecoveryCode(recoveryCode, records);
      if (!matchedRecord) {
        await client.query('commit');
        return { ok: false, status: 401, error: 'Codigo de recuperacao invalido ou ja utilizado.' };
      }
      await client.query(
        `
          update preddita_admin_mfa
          set recovery_codes = $2::jsonb, updated_at = now()
          where username = $1
        `,
        [user.username, JSON.stringify(records.filter((record) => record.id !== matchedRecord.id))]
      );
    } else {
      const secret = decryptMfaSecret(mfa.secret_ciphertext, ADMIN_MFA_ENCRYPTION_KEY);
      const verified = verifyTotp(secret, code, {
        window: 1,
        lastUsedCounter: Number(mfa.last_used_step),
      });
      if (!verified) {
        await client.query('commit');
        return { ok: false, status: 401, error: 'Codigo invalido, expirado ou ja utilizado.' };
      }
      await client.query(
        'update preddita_admin_mfa set last_used_step = $2, updated_at = now() where username = $1',
        [user.username, verified.counter]
      );
    }

    await client.query(
      'update preddita_admin_mfa_challenges set consumed_at = now() where token_hash = $1',
      [tokenHash]
    );
    await client.query('commit');
    return { ok: true, user, enrollment: false, recoveryCodes: [] };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function readJsonState(lockerId = DEFAULT_LOCKER_ID) {
  ensureDb();
  try {
    const parsed = parseJsonDocument(readFileSync(DB_PATH, 'utf8'));
    return migrateState(parsed, { lockerId });
  } catch (error) {
    throw stateReadError(DB_PATH, error);
  }
}

async function readPostgresState(lockerId = DEFAULT_LOCKER_ID, tenantId = DEFAULT_TENANT_ID) {
  const pool = await ensurePostgres();
  const normalizedTenantId = normalizeTenantId(tenantId);
  const normalizedLockerId = normalizeLockerId(lockerId);
  const result = await pool.query(
    `
      select state, operational_schema_version
      from preddita_locker_states
      where tenant_id = $1 and locker_id = $2
    `,
    [normalizedTenantId, normalizedLockerId]
  );
  if (result.rows[0]?.state) {
    const storedState = migrateState(result.rows[0].state, {
      tenantId: normalizedTenantId,
      lockerId: normalizedLockerId,
    });
    if (Number(result.rows[0].operational_schema_version) < OPERATIONAL_SCHEMA_VERSION) {
      await writePostgresState(storedState, normalizedLockerId, normalizedTenantId, { synchronizeCommands: true });
      return storedState;
    }
    return readNormalizedPostgresState(pool, normalizedLockerId, normalizedTenantId);
  }

  const initialState = await readInitialStateForPostgres(normalizedTenantId, normalizedLockerId);
  await writePostgresState(initialState, normalizedLockerId, normalizedTenantId, { synchronizeCommands: true });
  return initialState;
}

async function readNormalizedPostgresState(database, lockerId, tenantId) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const normalizedLockerId = normalizeLockerId(lockerId);
  const result = await database.query(
    `
      select state
      from preddita_locker_states
      where tenant_id = $1 and locker_id = $2
    `,
    [normalizedTenantId, normalizedLockerId]
  );
  if (!result.rows[0]?.state) throw new Error('Estado normalizado do locker nao foi encontrado.');
  const operationalState = await readOperationalState(database, {
    tenantId: normalizedTenantId,
    lockerId: normalizedLockerId,
  });
  return migrateState(
    { ...result.rows[0].state, ...operationalState },
    { tenantId: normalizedTenantId, lockerId: normalizedLockerId }
  );
}

async function readInitialStateForPostgres(tenantId, lockerId) {
  if (lockerId === DEFAULT_LOCKER_ID && existsSync(DB_PATH)) {
    try {
      const parsed = parseJsonDocument(readFileSync(DB_PATH, 'utf8'));
      return migrateState(parsed, { tenantId, lockerId });
    } catch (error) {
      throw stateReadError(DB_PATH, error);
    }
  }
  return createInitialState({ tenantId, lockerId });
}

async function readState(lockerId = DEFAULT_LOCKER_ID, tenantId = DEFAULT_TENANT_ID) {
  return isPostgresStorage()
    ? readPostgresState(lockerId, tenantId)
    : readJsonState(lockerId);
}

function pruneBackups() {
  if (!existsSync(BACKUP_DIR) || !Number.isFinite(MAX_BACKUPS) || MAX_BACKUPS <= 0) return;

  const backups = readdirSync(BACKUP_DIR)
    .filter((name) => name.startsWith('state-') && name.endsWith('.json'))
    .map((name) => {
      const path = join(BACKUP_DIR, name);
      return { name, path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  backups.slice(MAX_BACKUPS).forEach((backup) => unlinkSync(backup.path));
}

function createStateBackup() {
  if (!existsSync(DB_PATH)) return;
  const now = Date.now();
  if (lastBackupAt && now - lastBackupAt < BACKUP_INTERVAL_MS) return;

  const compactDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  copyFileSync(DB_PATH, join(BACKUP_DIR, `state-${compactDate}.json`));
  lastBackupAt = now;
  pruneBackups();
}

async function writeJsonState(state) {
  ensureDb();
  const next = { ...migrateState(state), updatedAt: nowIso() };
  const tempPath = `${DB_PATH}.tmp`;

  createStateBackup();

  writeFileSync(tempPath, JSON.stringify(next, null, 2));
  renameSync(tempPath, DB_PATH);
}

async function writePostgresState(
  state,
  lockerId = DEFAULT_LOCKER_ID,
  tenantId = DEFAULT_TENANT_ID,
  options = {}
) {
  const pool = await ensurePostgres();
  const normalizedTenantId = normalizeTenantId(state.tenant?.tenantId ?? tenantId);
  const normalizedLockerId = normalizeLockerId(state.tenant?.lockerId ?? state.device?.lockerId ?? lockerId);
  const next = { ...migrateState(state, { tenantId: normalizedTenantId, lockerId: normalizedLockerId }), updatedAt: nowIso() };
  await persistOperationalState(pool, {
    tenantId: normalizedTenantId,
    lockerId: normalizedLockerId,
    schemaVersion: SCHEMA_VERSION,
    state: next,
    synchronizeCommands: options.synchronizeCommands === true,
  });
}

async function writeState(state, lockerId = DEFAULT_LOCKER_ID, tenantId = DEFAULT_TENANT_ID) {
  if (isPostgresStorage()) {
    await writePostgresState(state, lockerId, tenantId);
    return;
  }
  await writeJsonState(state);
}

function withLockerStateMutation(lockerId, tenantId, operation) {
  const key = `${normalizeTenantId(tenantId)}:${normalizeLockerId(lockerId)}`;
  const previous = lockerStateMutationQueues.get(key) ?? Promise.resolve();
  const run = previous.then(() => operation());
  const tail = run.then(
    () => undefined,
    () => undefined
  );

  lockerStateMutationQueues.set(key, tail);
  void tail.then(() => {
    if (lockerStateMutationQueues.get(key) === tail) {
      lockerStateMutationQueues.delete(key);
    }
  });

  return run;
}

function withAudit(state, kind, message, meta = {}) {
  return {
    ...state,
    doors: (state.doors ?? []).map((door) => ({
      ...door,
      delivery: door.delivery ? {
        id: door.delivery.id,
        unit: door.delivery.unit,
        apartment: door.delivery.apartment,
        status: door.delivery.status,
      } : null,
    })),
    auditTrail: [
      { id: createId('audit'), kind, message, meta, at: nowIso() },
      ...(state.auditTrail ?? []),
    ].slice(0, 100),
  };
}

function withResidentsRevision(state, residents) {
  return {
    ...state,
    residents,
    residentsUpdatedAt: nowIso(),
  };
}

function isActiveCommandStatus(status) {
  return ['pending', 'leased', 'executing'].includes(cleanText(status));
}

function isTerminalCommandStatus(status) {
  return ['completed', 'failed'].includes(cleanText(status));
}

function withCommandRefreshAudit(state, result = {}) {
  const expiredCount = Number(result.expiredCount) || 0;
  const releasedLeaseCount = Number(result.releasedLeaseCount) || 0;
  if (expiredCount === 0 && releasedLeaseCount === 0) return state;
  return withAudit(
    state,
    expiredCount > 0 ? 'remote-open-expired' : 'remote-open-requeued',
    expiredCount > 0
      ? `${expiredCount} comando(s) remoto(s) expiraram.`
      : `${releasedLeaseCount} comando(s) remoto(s) voltaram para a fila apos expirar o lease.`,
    { expiredCount, releasedLeaseCount }
  );
}

function applyCommandAcknowledgement(state, command, options = {}) {
  const leaseId = cleanText(options.leaseId);
  const executionId = cleanText(options.executionId);
  const refreshedState = withCommandRefreshAudit(state, options.refresh);
  const refreshChanged = refreshedState !== state;

  if (isTerminalCommandStatus(command.status)) {
    if (command.executionId && command.executionId === executionId) {
      return {
        status: 200,
        payload: { ok: true, duplicate: true, terminal: true, command },
        state: refreshChanged ? refreshedState : null,
      };
    }
    return { status: 409, error: 'Comando ja foi finalizado por outra execucao.', state: refreshChanged ? refreshedState : null };
  }

  if (command.status === 'executing') {
    if (command.leaseId === leaseId && command.executionId === executionId) {
      return {
        status: 200,
        payload: { ok: true, duplicate: true, command },
        state: refreshChanged ? refreshedState : null,
      };
    }
    return { status: 409, error: 'Comando ja foi confirmado por outra execucao.', state: refreshChanged ? refreshedState : null };
  }

  if (command.status !== 'leased' || command.leaseId !== leaseId) {
    return {
      status: 409,
      error: 'Lease ausente, expirado ou substituido. Busque um novo snapshot.',
      state: refreshChanged ? refreshedState : null,
    };
  }

  if (command.executionId && command.executionId !== executionId) {
    return {
      status: 409,
      error: 'executionId diverge da execucao previamente registrada.',
      state: refreshChanged ? refreshedState : null,
    };
  }

  const acknowledgedAt = nowIso();
  const acknowledgedCommand = {
    ...command,
    status: 'executing',
    executionId,
    acknowledgedAt,
    leaseExpiresAt: new Date(Date.now() + COMMAND_EXECUTION_LEASE_MS).toISOString(),
    timeline: [
      ...(command.timeline ?? []),
      {
        status: 'executing',
        at: acknowledgedAt,
        detail: 'Armario confirmou o lease; execucao fisica autorizada.',
      },
    ],
  };
  const next = withAudit(
    {
      ...refreshedState,
      commands: (refreshedState.commands ?? []).map((item) =>
        item.id === command.id ? acknowledgedCommand : item
      ),
    },
    'remote-open-acknowledged',
    `Armario confirmou o comando remoto da porta ${command.door}.`,
    { commandId: command.id, executionId, leaseId }
  );
  return {
    status: 200,
    payload: { ok: true, duplicate: false, command: acknowledgedCommand },
    command: acknowledgedCommand,
    state: next,
  };
}

function applyCommandCompletion(state, command, body = {}, options = {}) {
  const executionId = cleanText(body.executionId);
  const refreshedState = withCommandRefreshAudit(state, options.refresh);
  const refreshChanged = refreshedState !== state;
  if (!executionId) {
    return { status: 400, error: 'executionId e obrigatorio para finalizar o comando.', state: refreshChanged ? refreshedState : null };
  }
  if (executionId.length > 200) {
    return { status: 400, error: 'executionId excede o tamanho permitido.', state: refreshChanged ? refreshedState : null };
  }

  const sameExecution = command.executionId && command.executionId === executionId;
  if (isTerminalCommandStatus(command.status) && !(command.result?.expired && sameExecution)) {
    if (sameExecution) {
      return {
        status: 200,
        payload: { ok: true, duplicate: true, command },
        state: refreshChanged ? refreshedState : null,
      };
    }
    return { status: 409, error: 'Comando ja foi finalizado por outra execucao.', state: refreshChanged ? refreshedState : null };
  }

  if (!sameExecution) {
    return {
      status: 409,
      error: 'Comando nao recebeu ACK para este executionId.',
      state: refreshChanged ? refreshedState : null,
    };
  }

  const commandDoor = Number.parseInt(command.door, 10);
  const requestedDeliveryId = cleanText(body.releasedDeliveryId);
  const requestedDelivery = (refreshedState.deliveries ?? []).find((delivery) =>
    delivery.id === requestedDeliveryId &&
    isActiveDeliveryStatus(delivery.status) &&
    Number.parseInt(delivery.door, 10) === commandDoor
  );
  const deliveryOnDoor = requestedDelivery ?? (refreshedState.deliveries ?? []).find((delivery) =>
    isActiveDeliveryStatus(delivery.status) && Number.parseInt(delivery.door, 10) === commandDoor
  );
  const doorHadOccupancy = (refreshedState.doors ?? []).some((door) =>
    Number.parseInt(door.channel, 10) === commandDoor && door.occupancy === 'busy'
  );
  const physicalCloseProof = body.physicalCloseProof && typeof body.physicalCloseProof === 'object'
    ? body.physicalCloseProof
    : null;
  const physicalOpenCycle = body.physicalOpenCycle && typeof body.physicalOpenCycle === 'object'
    ? body.physicalOpenCycle
    : null;
  const cycleBaselineAt = Date.parse(cleanText(physicalOpenCycle?.baselineReadAt));
  const cycleOpenedAt = Date.parse(cleanText(physicalOpenCycle?.openedAt));
  const proofOpenedAt = Date.parse(cleanText(physicalCloseProof?.openedAt));
  const proofClosedAt = Date.parse(cleanText(physicalCloseProof?.closedAt));
  const physicalCloseConfirmed = Boolean(
    body.physicalCloseConfirmed === true &&
    physicalCloseProof &&
    physicalOpenCycle &&
    Number.parseInt(physicalOpenCycle.channel, 10) === commandDoor &&
    Number.parseInt(physicalCloseProof.channel, 10) === commandDoor &&
    ['zeroOpen', 'zeroClosed'].includes(cleanText(physicalOpenCycle.sensorPolarity)) &&
    cleanText(physicalCloseProof.sensorPolarity) === cleanText(physicalOpenCycle.sensorPolarity) &&
    Number.isInteger(Number(physicalOpenCycle.closedStateByte)) &&
    Number.isInteger(Number(physicalOpenCycle.openStateByte)) &&
    Number(physicalOpenCycle.closedStateByte) !== Number(physicalOpenCycle.openStateByte) &&
    Number(physicalCloseProof.stateByte) === Number(physicalOpenCycle.closedStateByte) &&
    cleanText(physicalCloseProof.openedAt) === cleanText(physicalOpenCycle.openedAt) &&
    Number.isFinite(cycleBaselineAt) &&
    Number.isFinite(cycleOpenedAt) &&
    Number.isFinite(proofOpenedAt) &&
    Number.isFinite(proofClosedAt) &&
    cycleOpenedAt > cycleBaselineAt &&
    proofClosedAt > proofOpenedAt
  );
  const shouldReleaseDoor = Boolean(
    body.ok &&
    body.releasedDoor === true &&
    physicalCloseConfirmed &&
    Number.isInteger(commandDoor) &&
    (doorHadOccupancy || deliveryOnDoor)
  );
  const completedAt = nowIso();
  const normalizedResult = {
    ...body,
    ok: Boolean(body.ok),
    executionId,
    door: commandDoor,
    physicalCloseConfirmed,
    physicalCloseProof: physicalCloseConfirmed ? physicalCloseProof : null,
    releasedDoor: shouldReleaseDoor,
    releasedDeliveryId: shouldReleaseDoor && deliveryOnDoor ? deliveryOnDoor.id : '',
  };
  const nextDeliveries = shouldReleaseDoor
    ? (refreshedState.deliveries ?? []).map((delivery) => {
        if (delivery.id !== normalizedResult.releasedDeliveryId) return delivery;
        if (delivery.status === 'door_opened_for_dropoff') {
          return {
            ...delivery,
            status: 'cancelled',
            cancelledAt: completedAt,
            cancelReason: 'Porta liberada por abertura remota do administrador.',
          };
        }
        return {
          ...delivery,
          status: 'collected',
          pickupOpenedAt: delivery.pickupOpenedAt || completedAt,
          collectedAt: completedAt,
        };
      })
    : refreshedState.deliveries;
  const nextDoors = shouldReleaseDoor
    ? (refreshedState.doors ?? []).map((door) =>
        Number.parseInt(door.channel, 10) === commandDoor
          ? { ...door, occupancy: 'free', delivery: null, lastSeenAt: completedAt }
          : door
      )
    : refreshedState.doors;
  const completedCommand = {
    ...command,
    status: body.ok ? 'completed' : 'failed',
    completedAt,
    leaseId: '',
    leaseExpiresAt: '',
    result: normalizedResult,
    timeline: [
      ...(command.timeline ?? []),
      {
        status: body.ok ? 'completed' : 'failed',
        at: completedAt,
        detail: body.ok
          ? 'Armario confirmou o resultado do comando.'
          : cleanText(body.error) || 'Armario retornou falha.',
      },
    ],
  };
  const next = withAudit(
    {
      ...refreshedState,
      doors: nextDoors,
      deliveries: nextDeliveries,
      commands: (refreshedState.commands ?? []).map((item) =>
        item.id === command.id ? completedCommand : item
      ),
    },
    body.ok ? 'remote-open-completed' : 'remote-open-failed',
    `Comando remoto da porta ${command.door} finalizado.`,
    { commandId: command.id, executionId, result: normalizedResult }
  );
  return {
    status: 200,
    payload: { ok: true, duplicate: false, command: completedCommand },
    command: completedCommand,
    state: next,
  };
}

function refreshCommandLeases(state) {
  const now = Date.now();
  let expiredCount = 0;
  let releasedLeaseCount = 0;
  const commands = (state.commands ?? []).map((command) => {
    const reconciled = reconcileOperationalCommand(command, { nowMs: now, commandTtlMs: COMMAND_TTL_MS });
    expiredCount += reconciled.expiredCount;
    releasedLeaseCount += reconciled.releasedLeaseCount;
    return reconciled.command;
  });

  if (expiredCount === 0 && releasedLeaseCount === 0) {
    return { state, changed: false };
  }

  return {
    changed: true,
    state: withCommandRefreshAudit({ ...state, commands }, { expiredCount, releasedLeaseCount }),
  };
}

async function readFreshState(lockerId = DEFAULT_LOCKER_ID, tenantId = DEFAULT_TENANT_ID) {
  if (isPostgresStorage()) {
    const pool = await ensurePostgres();
    const refresh = await refreshOperationalCommands(pool, {
      tenantId: normalizeTenantId(tenantId),
      lockerId: normalizeLockerId(lockerId),
      commandTtlMs: COMMAND_TTL_MS,
    });
    const current = await readState(lockerId, tenantId);
    if (refresh.expiredCount === 0 && refresh.releasedLeaseCount === 0) return current;
    const next = withCommandRefreshAudit(current, refresh);
    await writeState(next, lockerId, tenantId);
    return next;
  }
  const current = await readState(lockerId, tenantId);
  const result = refreshCommandLeases(current);
  if (result.changed) await writeState(result.state, lockerId, tenantId);
  return result.state;
}

function getDeviceAgeMs(state) {
  const lastSeen = Date.parse(state.device?.lastSeenAt);
  return Number.isFinite(lastSeen) ? Date.now() - lastSeen : null;
}

function getRuntimeSummary(state) {
  const deviceAgeMs = getDeviceAgeMs(state);
  const deviceFresh = Number.isFinite(deviceAgeMs) && deviceAgeMs <= DEVICE_STALE_MS;
  const commands = state.commands ?? [];
  const deliveries = state.deliveries ?? [];
  const doors = state.doors ?? [];
  const notificationOutbox = state.notificationOutbox ?? [];
  const activeDeliveries = deliveries.filter((delivery) => isActiveDeliveryStatus(delivery.status));
  const storedDeliveries = deliveries.filter((delivery) => cleanText(delivery.status) === 'stored');
  const reminder24hCount = storedDeliveries.filter((delivery) => getStoredDeliveryAgeHours(delivery) >= 24).length;
  const reminder48hCount = storedDeliveries.filter((delivery) => getStoredDeliveryAgeHours(delivery) >= 48).length;
  const reminder72hCount = storedDeliveries.filter((delivery) => getStoredDeliveryAgeHours(delivery) >= 72).length;
  const pendingCommands = commands.filter((command) => isActiveCommandStatus(command.status));
  const failedCommands = commands.filter((command) => command.status === 'failed').slice(0, 8);
  const largeDoors = doors.filter((door) => door.size === 'G');
  const mediumDoors = doors.filter((door) => door.size === 'M');
  const smallDoors = doors.filter((door) => door.size === 'P');

  return {
    appVersion: APP_VERSION,
    deviceFresh,
    deviceAgeMs,
    staleAfterMs: DEVICE_STALE_MS,
    pendingCommandCount: pendingCommands.length,
    activeDeliveryCount: activeDeliveries.length,
    storedDeliveryCount: storedDeliveries.length,
    overdueDeliveryCount: reminder24hCount,
    reminder24hCount,
    reminder48hCount,
    reminder72hCount,
    pendingReminderCount: storedDeliveries.filter((delivery) => getDeliveryReminderDue(delivery)).length,
    occupiedDoorCount: doors.filter((door) => door.occupancy === 'busy').length,
    freeDoorCount: doors.filter((door) => door.occupancy !== 'busy').length,
    largeDoorCount: largeDoors.length,
    mediumDoorCount: mediumDoors.length,
    smallDoorCount: smallDoors.length,
    freeLargeDoorCount: largeDoors.filter((door) => door.occupancy !== 'busy').length,
    freeMediumDoorCount: mediumDoors.filter((door) => door.occupancy !== 'busy').length,
    freeSmallDoorCount: smallDoors.filter((door) => door.occupancy !== 'busy').length,
    failedCommands,
    smtpConfigured: isSmtpConfigured(),
    pendingNotificationCount: notificationOutbox.filter((item) => ['pending', 'failed'].includes(cleanText(item.status))).length,
    failedNotificationCount: notificationOutbox.filter((item) => cleanText(item.status) === 'failed').length,
    deviceAuthMode: DEVICE_AUTH_MODE,
    storageMode: STORAGE_MODE,
    operationalStorage: isPostgresStorage() ? 'normalized-postgres' : 'snapshot',
    operationalSchemaVersion: isPostgresStorage() ? OPERATIONAL_SCHEMA_VERSION : 0,
    commandMutationStorage: isPostgresStorage() ? 'row-postgres' : 'snapshot',
    commandSchemaVersion: isPostgresStorage() ? COMMAND_SCHEMA_VERSION : 0,
    commandTransactionRetryAttempts: isPostgresStorage() ? COMMAND_TRANSACTION_RETRY_ATTEMPTS : 0,
    adminSessionStorage: isPostgresStorage() ? 'postgres' : 'memory',
    adminMfa: isPostgresStorage() && ADMIN_MFA_ENCRYPTION_KEY ? 'privileged-roles' : 'disabled',
    securityWarnings: getSecurityWarnings(),
  };
}

function getLockerSummary(state) {
  const runtime = getRuntimeSummary(state);
  const tenant = state.tenant ?? {};
  const doors = state.doors ?? [];
  const deliveries = state.deliveries ?? [];
  const commands = state.commands ?? [];

  return {
    id: cleanText(tenant.lockerId) || DEFAULT_LOCKER_ID,
    name: cleanText(tenant.lockerName) || 'Locker',
    siteName: cleanText(tenant.siteName) || 'Condominio sem nome',
    online: Boolean(state.device?.online && runtime.deviceFresh),
    stale: !runtime.deviceFresh,
    serialOpen: Boolean(state.device?.serialOpen),
    serialPath: cleanText(state.device?.serialPath),
    bridgeVersion: cleanText(state.device?.bridgeVersion),
    edgeAppVersion: cleanText(state.device?.edgeAppVersion),
    commissioningStatus: cleanText(state.device?.commissioningStatus) || 'pending',
    commissionedAt: cleanText(state.device?.commissionedAt),
    unlockTimeoutSeconds: Number.parseInt(state.device?.unlockTimeoutSeconds, 10) || 0,
    board: state.device?.board ?? 1,
    doorCount: doors.length || state.device?.doorCount || 0,
    largeDoorCount: runtime.largeDoorCount,
    mediumDoorCount: runtime.mediumDoorCount,
    smallDoorCount: runtime.smallDoorCount,
    freeLargeDoorCount: runtime.freeLargeDoorCount,
    freeMediumDoorCount: runtime.freeMediumDoorCount,
    freeSmallDoorCount: runtime.freeSmallDoorCount,
    occupiedDoorCount: runtime.occupiedDoorCount,
    freeDoorCount: runtime.freeDoorCount,
    activeDeliveryCount: runtime.activeDeliveryCount,
    storedDeliveryCount: runtime.storedDeliveryCount,
    overdueDeliveryCount: runtime.overdueDeliveryCount,
    reminder48hCount: runtime.reminder48hCount,
    reminder72hCount: runtime.reminder72hCount,
    pendingCommandCount: runtime.pendingCommandCount,
    failedCommandCount: commands.filter((command) => command.status === 'failed').length,
    residentCount: (state.residents ?? []).length,
    lastSeenAt: cleanText(state.device?.lastSeenAt),
    deviceAgeMs: runtime.deviceAgeMs,
  };
}

function getPlatformSummary(state) {
  const lockers = [getLockerSummary(state)];
  return {
    lockerCount: lockers.length,
    onlineLockerCount: lockers.filter((locker) => locker.online).length,
    offlineLockerCount: lockers.filter((locker) => !locker.online).length,
    activeDeliveryCount: lockers.reduce((total, locker) => total + locker.activeDeliveryCount, 0),
    pendingCommandCount: lockers.reduce((total, locker) => total + locker.pendingCommandCount, 0),
    failedCommandCount: lockers.reduce((total, locker) => total + locker.failedCommandCount, 0),
    lockers,
  };
}

function getSecurityWarnings() {
  const warnings = [];
  if (!ADMIN_USERS_BOOTSTRAP_CONFIGURED && !isPostgresStorage()) {
    warnings.push('PREDDITA_ADMIN_USERS nao foi definido; usando usuarios e senhas locais de desenvolvimento.');
  }
  if (!ADMIN_MFA_ENCRYPTION_KEY) {
    warnings.push('PREDDITA_MFA_ENCRYPTION_KEY nao foi definido; MFA de contas privilegiadas esta desabilitado.');
  } else if (!isPostgresStorage()) {
    warnings.push('MFA de contas privilegiadas requer armazenamento Postgres.');
  }
  if (ALLOW_LEGACY_ADMIN_TOKENS) {
    warnings.push('PREDDITA_LEGACY_ADMIN_TOKENS esta habilitado para compatibilidade local.');
  }
  if (DEVICE_KEY === DEFAULT_DEVICE_KEY) {
    warnings.push('PREDDITA_DEVICE_KEY esta usando o valor local padrao.');
  }
  if (DEVICE_KEYS.size <= 1 && !process.env.PREDDITA_DEVICE_KEYS) {
    warnings.push('PREDDITA_DEVICE_KEYS nao foi definido; usando uma unica chave de dispositivo.');
  }
  if (DEVICE_AUTH_MODE !== 'hmac') {
    warnings.push(`Autenticacao de dispositivo esta em modo ${DEVICE_AUTH_MODE}; use hmac antes de publicar.`);
  }
  if (ALLOWED_ORIGINS.length === 0) {
    warnings.push('PREDDITA_ALLOWED_ORIGINS nao foi definido; CORS esta permissivo.');
  }
  return warnings;
}

function redactAdminAuditMessage(message) {
  return cleanText(message).replace(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    '[dado protegido]'
  );
}

function redactAdminNotification(notification, session) {
  if (!notification || session?.canViewPersonalData) return notification;
  return {
    status: notification.status,
    requestedAt: notification.requestedAt,
    sentAt: notification.sentAt,
    error: redactAdminAuditMessage(notification.error),
    ...(notification.duplicate ? { duplicate: true } : {}),
    ...(notification.queued ? { queued: true } : {}),
  };
}

function redactAdminState(state, session) {
  if (session?.canViewPersonalData) return state;
  return {
    ...state,
    residents: (state.residents ?? []).map((resident) => ({
      id: resident.id,
      apartment: resident.apartment,
      building: resident.building,
      floor: resident.floor,
      createdAt: resident.createdAt,
      updatedAt: resident.updatedAt,
    })),
    doors: (state.doors ?? []).map((door) => ({
      ...door,
      delivery: door.delivery ? {
        id: door.delivery.id,
        unit: door.delivery.unit,
        apartment: door.delivery.apartment,
        status: door.delivery.status,
      } : null,
    })),
    deliveries: (state.deliveries ?? []).map((delivery) => ({
      id: delivery.id,
      unit: delivery.unit,
      apartment: delivery.apartment,
      building: delivery.building,
      floor: delivery.floor,
      door: delivery.door,
      size: delivery.size,
      status: delivery.status,
      notificationStatus: delivery.notificationStatus,
      createdAt: delivery.createdAt,
      depositedAt: delivery.depositedAt,
      pickupOpenedAt: delivery.pickupOpenedAt,
      collectedAt: delivery.collectedAt,
      expiresAt: delivery.expiresAt,
      labelPhotoCapturedAt: delivery.labelPhotoCapturedAt,
      labelProofRequired: delivery.labelProofRequired,
      reminderLevel: delivery.reminderLevel,
      reminderLastSentAt: delivery.reminderLastSentAt,
      reminderError: redactAdminAuditMessage(delivery.reminderError),
    })),
    auditTrail: (state.auditTrail ?? []).map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      message: redactAdminAuditMessage(entry.message),
      at: entry.at,
    })),
    notificationOutbox: [],
  };
}

function decorateStateForAdmin(state, session) {
  const runtime = getRuntimeSummary(state);
  const safeState = redactAdminState(state, session);
  const safeRuntime = {
    ...runtime,
    securityWarnings: session?.canViewSecurity ? runtime.securityWarnings : [],
  };
  return {
    ...safeState,
    runtime: safeRuntime,
    session,
    platform: session?.canViewPlatform ? getPlatformSummary(state) : null,
    device: {
      ...state.device,
      online: Boolean(state.device?.online && runtime.deviceFresh),
      stale: !runtime.deviceFresh,
    },
  };
}

function getRemoteOpenBlockReason(state, door) {
  const runtime = getRuntimeSummary(state);
  if (!state.device?.online || !runtime.deviceFresh) {
    return 'Armario offline ou sem sinal recente. Aguarde o equipamento sincronizar antes de abrir uma porta.';
  }
  if (!state.device?.serialOpen) {
    return 'Serial do armario fechada. Reabra o app no equipamento ou verifique a conexao RS-485 antes de abrir uma porta.';
  }

  const pendingForDoor = (state.commands ?? []).find((command) =>
    isActiveCommandStatus(command.status) &&
    Number.parseInt(command.door, 10) === door
  );
  if (pendingForDoor) {
    return 'Ja existe um comando pendente para esta porta. Aguarde a confirmacao do armario.';
  }

  return '';
}

function normalizeResident(payload, previous = {}) {
  const floor = cleanText(payload.floor ?? previous.floor);
  const apartment = cleanText(payload.apartment ?? previous.apartment);
  const building = cleanText(payload.building ?? previous.building) || 'Torre A';

  return {
    id: previous.id ?? createId('resident'),
    firstName: '',
    lastName: '',
    phone: cleanText(payload.phone ?? previous.phone),
    email: cleanText(payload.email ?? previous.email).toLowerCase(),
    cpf: '',
    floor,
    apartment,
    building,
    createdAt: previous.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  };
}

function normalizeDeliveryPayload(payload = {}) {
  const raw = payload.delivery && typeof payload.delivery === 'object' ? payload.delivery : payload;
  return {
    ...raw,
    id: cleanText(raw.id),
    recipientId: cleanText(raw.recipientId),
    recipientName: cleanText(raw.recipientName),
    recipientEmail: cleanText(raw.recipientEmail).toLowerCase(),
    recipientCpf: cleanText(raw.recipientCpf),
    unit: cleanText(raw.unit),
    building: cleanText(raw.building),
    courierName: cleanText(raw.courierName),
    orderCode: cleanText(raw.orderCode),
    externalCode: cleanText(raw.externalCode),
    notes: cleanText(raw.notes),
    door: Number.parseInt(raw.door, 10),
    doorSize: cleanText(raw.doorSize || raw.size),
    size: cleanText(raw.size || raw.doorSize),
    pin: cleanText(raw.pin),
    token: cleanText(raw.token),
    qrPayload: cleanText(raw.qrPayload),
    status: cleanText(raw.status) || 'stored',
    notificationStatus: cleanText(raw.notificationStatus),
    notificationRequestedAt: cleanText(raw.notificationRequestedAt),
    notificationSentAt: cleanText(raw.notificationSentAt),
    notificationError: cleanText(raw.notificationError),
    notificationMessageId: cleanText(raw.notificationMessageId),
    labelPhotoDataUrl: normalizeImageDataUrl(raw.labelPhotoDataUrl),
    labelPhotoCapturedAt: cleanText(raw.labelPhotoCapturedAt),
    labelOcrStatus: cleanText(raw.labelOcrStatus),
    labelOcrText: cleanText(raw.labelOcrText),
    labelOcrApartment: cleanText(raw.labelOcrApartment),
    labelOcrConfidence: Number.isFinite(Number(raw.labelOcrConfidence)) ? Number(raw.labelOcrConfidence) : null,
    labelProofRequired: Boolean(raw.labelProofRequired),
    reminderLevel: Number.isFinite(Number(raw.reminderLevel)) ? Math.max(0, Number(raw.reminderLevel)) : 0,
    reminderLastQueuedAt: cleanText(raw.reminderLastQueuedAt),
    reminderLastSentAt: cleanText(raw.reminderLastSentAt),
    reminderError: cleanText(raw.reminderError),
    createdAt: cleanText(raw.createdAt) || nowIso(),
    depositedAt: cleanText(raw.depositedAt) || nowIso(),
    pickupOpenedAt: cleanText(raw.pickupOpenedAt),
    collectedAt: cleanText(raw.collectedAt),
    cancelledAt: cleanText(raw.cancelledAt),
    cancelReason: cleanText(raw.cancelReason),
    expiresAt: cleanText(raw.expiresAt),
  };
}

function isSmtpConfigured() {
  return Boolean(SMTP_HOST && SMTP_FROM && Number.isInteger(SMTP_PORT));
}

async function buildQrAttachment(qrPayload) {
  if (!qrPayload) return null;

  try {
    const qrModule = await import('qrcode');
    const QRCode = qrModule.default ?? qrModule;
    const dataUrl = await QRCode.toDataURL(qrPayload, {
      margin: 1,
      width: 280,
      color: {
        dark: '#061b31',
        light: '#ffffff',
      },
    });
    const base64 = dataUrl.split(',')[1];
    if (!base64) return null;

    return {
      filename: 'preddita-qr-retirada.png',
      content: Buffer.from(base64, 'base64'),
      cid: 'preddita-qr-retirada',
    };
  } catch (_error) {
    return null;
  }
}

function buildEvidenceAttachment(delivery) {
  const dataUrl = normalizeImageDataUrl(delivery.labelPhotoDataUrl);
  if (!dataUrl) return null;

  const match = dataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i);
  if (!match) return null;

  const contentType = match[1].toLowerCase().replace('image/jpg', 'image/jpeg');
  const extension = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';

  return {
    filename: `preddita-etiqueta-${cleanText(delivery.door) || 'porta'}.${extension}`,
    content: Buffer.from(match[2], 'base64'),
    contentType,
    cid: 'preddita-etiqueta-comprovante',
  };
}

function buildDeliveryEmail(delivery, qrCid, evidenceCid) {
  const siteName = escapeHtml(delivery.building || 'PREDDITA Locker');
  const unit = escapeHtml(delivery.unit || 'unidade cadastrada');
  const door = escapeHtml(delivery.door || '--');
  const pin = escapeHtml(delivery.pin || '--');
  const qrPayload = escapeHtml(delivery.qrPayload || '');
  const expiresAt = delivery.expiresAt ? `Valido ate: ${delivery.expiresAt}` : '';
  const isReminder = isReminderReason(delivery.notificationReason);
  const subject = isReminder
    ? `PREDDITA Locker - lembrete de encomenda aguardando retirada`
    : `PREDDITA Locker - sua encomenda chegou`;
  const qrBlock = qrCid
    ? `<img src="cid:${qrCid}" alt="QR Code de retirada" style="width:220px;height:220px;border-radius:18px;border:1px solid #dbe8f4;padding:10px;background:#fff;" />`
    : `<p style="word-break:break-all;font-size:12px;color:#52697f;">${qrPayload}</p>`;
  const evidenceText = evidenceCid ? 'Comprovante fotografico da etiqueta anexado.' : '';
  const evidenceBlock = evidenceCid
    ? `
      <div style="display:block;background:#f7fbff;border:1px solid #dbe8f4;border-radius:22px;padding:18px;margin:18px 0;text-align:center;">
        <p style="margin:0 0 10px;color:#52697f;font-size:13px;">Comprovante da etiqueta registrado no deposito</p>
        <img src="cid:${evidenceCid}" alt="Foto da etiqueta da encomenda" style="max-width:100%;width:320px;border-radius:18px;border:1px solid #dbe8f4;background:#fff;" />
      </div>
    `
    : '';

  const text = [
    isReminder
      ? `Ola, sua encomenda ainda esta aguardando retirada no ${delivery.building || 'PREDDITA Locker'}.`
      : `Ola, sua encomenda chegou no ${delivery.building || 'PREDDITA Locker'}.`,
    `Unidade: ${delivery.unit || 'nao informada'}`,
    `Porta: ${delivery.door || '--'}`,
    `PIN: ${delivery.pin || '--'}`,
    `QR PREDDITA: ${delivery.qrPayload || '--'}`,
    evidenceText,
    expiresAt,
    'Use o PIN ou o QR na tela Buscar entrega do armario.',
  ].filter(Boolean).join('\n');

  const html = `
    <div style="margin:0;padding:0;background:#eef6ff;font-family:Segoe UI,Arial,sans-serif;color:#061b31;">
      <div style="max-width:620px;margin:0 auto;padding:28px;">
        <div style="background:#ffffff;border:1px solid #dbe8f4;border-radius:28px;padding:28px;box-shadow:0 18px 50px rgba(6,27,49,.12);">
          <p style="margin:0 0 8px;color:#0587ff;letter-spacing:.16em;text-transform:uppercase;font-size:12px;font-weight:800;">PREDDITA Locker</p>
          <h1 style="margin:0 0 10px;font-size:30px;line-height:1.05;">${isReminder ? 'Lembrete de retirada' : 'Sua encomenda chegou'}</h1>
          <p style="margin:0 0 24px;color:#52697f;">${isReminder ? 'Esta encomenda ainda esta no armario. Use o PIN ou o QR abaixo para retirar.' : 'Use o PIN ou o QR abaixo para retirar sua entrega no armario.'}</p>
          <div style="display:block;background:#f4f9ff;border:1px solid #dbe8f4;border-radius:22px;padding:20px;margin-bottom:18px;">
            <p style="margin:0 0 8px;color:#52697f;font-size:13px;">Local</p>
            <p style="margin:0;font-size:18px;font-weight:800;">${siteName}</p>
            <p style="margin:6px 0 0;color:#52697f;">${unit} | Porta ${door}</p>
          </div>
          <div style="display:block;background:#061b31;color:#ffffff;border-radius:24px;padding:24px;text-align:center;margin-bottom:18px;">
            <p style="margin:0 0 8px;color:#9ee8ff;text-transform:uppercase;letter-spacing:.16em;font-size:12px;font-weight:800;">PIN de retirada</p>
            <p style="margin:0;font-size:46px;letter-spacing:.18em;font-weight:900;">${pin}</p>
          </div>
          <div style="text-align:center;margin:22px 0;">
            ${qrBlock}
            <p style="margin:12px 0 0;color:#52697f;font-size:13px;">Tambem e possivel ler este QR na tela Buscar entrega.</p>
          </div>
          ${evidenceBlock}
          <p style="margin:18px 0 0;color:#52697f;font-size:13px;">Nao compartilhe este codigo com terceiros. Se voce nao reconhece esta entrega, fale com a administracao do condominio.</p>
        </div>
      </div>
    </div>
  `;

  return { subject, text, html };
}

async function sendDeliveryEmail(delivery) {
  if (!isValidEmail(delivery.recipientEmail)) {
    throw new Error('Apartamento sem e-mail valido cadastrado.');
  }

  if (!isSmtpConfigured()) {
    throw new Error('SMTP nao configurado. Preencha PREDDITA_SMTP_HOST, PREDDITA_SMTP_FROM, PREDDITA_SMTP_USER e PREDDITA_SMTP_PASS no servidor.');
  }

  let nodemailer;
  try {
    const mailModule = await import('nodemailer');
    nodemailer = mailModule.default ?? mailModule;
  } catch (_error) {
    throw new Error('Dependencia nodemailer nao instalada. Rode npm install na pasta admin-online.');
  }

  const qrAttachment = await buildQrAttachment(delivery.qrPayload);
  const evidenceAttachment = buildEvidenceAttachment(delivery);
  const message = buildDeliveryEmail(delivery, qrAttachment?.cid, evidenceAttachment?.cid);
  const auth = SMTP_USER || SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined;
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth,
  });

  return transporter.sendMail({
    from: SMTP_FROM,
    to: delivery.recipientEmail,
    subject: message.subject,
    text: message.text,
    html: message.html,
    attachments: [qrAttachment, evidenceAttachment].filter(Boolean),
  });
}

function withDeliveryNotification(state, delivery, notification) {
  const deliveryId = cleanText(delivery.id);
  const nextDelivery = {
    ...delivery,
    notificationStatus: cleanText(notification.status),
    notificationRequestedAt: cleanText(notification.requestedAt),
    notificationSentAt: cleanText(notification.sentAt),
    notificationError: cleanText(notification.error),
    notificationMessageId: cleanText(notification.messageId),
  };
  let found = false;
  const deliveries = (state.deliveries ?? []).map((item) => {
    if (cleanText(item.id) !== deliveryId) return item;
    found = true;
    return { ...item, ...nextDelivery };
  });

  return {
    ...state,
    deliveries: found ? deliveries : [nextDelivery, ...deliveries],
  };
}

function normalizeNotificationOutboxItem(item = {}) {
  return {
    id: cleanText(item.id) || createId('mail'),
    deliveryId: cleanText(item.deliveryId),
    status: cleanText(item.status) || 'pending',
    reason: cleanText(item.reason) || 'delivery-stored',
    requestedAt: cleanText(item.requestedAt) || nowIso(),
    lastAttemptAt: cleanText(item.lastAttemptAt),
    nextAttemptAt: cleanText(item.nextAttemptAt),
    sentAt: cleanText(item.sentAt),
    error: cleanText(item.error),
    messageId: cleanText(item.messageId),
    attempts: Number.isFinite(Number(item.attempts)) ? Math.max(0, Number(item.attempts)) : 0,
    force: Boolean(item.force),
  };
}

function notificationRetryDelayMs(attempts) {
  const safeAttempts = Math.max(0, Number.parseInt(attempts, 10) || 0);
  return Math.min(30 * 60_000, 60_000 * 2 ** safeAttempts);
}

function findQueuedNotification(outbox = [], deliveryId) {
  const normalizedDeliveryId = cleanText(deliveryId);
  return outbox.find((item) =>
    cleanText(item.deliveryId) === normalizedDeliveryId &&
    ['pending', 'failed'].includes(cleanText(item.status)) &&
    (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= Date.now())
  );
}

function queueDeliveryNotification(state, payload, options = {}) {
  const delivery = normalizeDeliveryPayload(payload);
  if (!delivery.id) {
    throw new Error('Entrega sem identificador.');
  }

  const existing = (state.deliveries ?? []).find((item) => item.id === delivery.id);
  const mergedDelivery = { ...existing, ...delivery };
  if (!options.force && existing?.notificationStatus === 'sent' && existing.notificationSentAt) {
    return {
      state,
      notification: {
        status: 'sent',
        requestedAt: existing.notificationRequestedAt,
        sentAt: existing.notificationSentAt,
        messageId: existing.notificationMessageId,
        duplicate: true,
      },
    };
  }

  if (!isValidEmail(mergedDelivery.recipientEmail)) {
    const notification = {
      status: mergedDelivery.recipientEmail ? 'failed' : 'skipped',
      requestedAt: cleanText(options.requestedAt) || nowIso(),
      sentAt: '',
      error: mergedDelivery.recipientEmail ? 'Apartamento sem e-mail valido cadastrado.' : 'Apartamento sem e-mail cadastrado.',
      messageId: '',
    };
    return {
      state: withDeliveryNotification(state, mergedDelivery, notification),
      notification,
    };
  }

  const requestedAt = cleanText(options.requestedAt) || nowIso();
  const notification = {
    status: 'pending',
    requestedAt,
    sentAt: '',
    error: '',
    messageId: '',
    queued: true,
  };
  const outbox = (state.notificationOutbox ?? []).map(normalizeNotificationOutboxItem);
  const existingQueued = findQueuedNotification(outbox, mergedDelivery.id);
  const outboxItem = normalizeNotificationOutboxItem({
    ...(existingQueued ?? {}),
    id: existingQueued?.id || createId('mail'),
    deliveryId: mergedDelivery.id,
    status: 'pending',
    reason: cleanText(options.reason) || 'delivery-stored',
    requestedAt,
    nextAttemptAt: '',
    error: '',
    force: Boolean(options.force),
  });

  const nextOutbox = [
    outboxItem,
    ...outbox.filter((item) => item.id !== outboxItem.id),
  ].slice(0, MAX_NOTIFICATION_OUTBOX);

  return {
    state: withAudit(
      {
        ...withDeliveryNotification(state, mergedDelivery, notification),
        notificationOutbox: nextOutbox,
      },
      'delivery-email-queued',
      `PIN e QR enfileirados para ${mergedDelivery.recipientEmail}.`,
      { deliveryId: mergedDelivery.id, recipientEmail: mergedDelivery.recipientEmail, outboxId: outboxItem.id }
    ),
    notification,
  };
}

function withDeliveryReminder(state, deliveryId, reminder = {}) {
  const normalizedId = cleanText(deliveryId);
  return {
    ...state,
    deliveries: (state.deliveries ?? []).map((delivery) =>
      cleanText(delivery.id) === normalizedId
        ? {
            ...delivery,
            reminderLevel: Number.isFinite(Number(reminder.level)) ? Number(reminder.level) : Number(delivery.reminderLevel) || 0,
            reminderLastQueuedAt: cleanText(reminder.queuedAt || delivery.reminderLastQueuedAt),
            reminderLastSentAt: cleanText(reminder.sentAt || delivery.reminderLastSentAt),
            reminderError: cleanText(reminder.error),
          }
        : delivery
    ),
  };
}

function queueDueDeliveryReminders(state, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const requestedAt = new Date(nowMs).toISOString();
  let nextState = {
    ...state,
    notificationOutbox: (state.notificationOutbox ?? []).map(normalizeNotificationOutboxItem),
  };
  const queued = [];
  const alreadyQueuedDeliveryIds = new Set(
    nextState.notificationOutbox
      .filter((item) => ['pending', 'failed'].includes(cleanText(item.status)))
      .map((item) => cleanText(item.deliveryId))
  );

  for (const delivery of nextState.deliveries ?? []) {
    const due = getDeliveryReminderDue(delivery, nowMs);
    if (!due || alreadyQueuedDeliveryIds.has(cleanText(delivery.id)) || !isValidEmail(delivery.recipientEmail)) {
      continue;
    }

    const result = queueDeliveryNotification(nextState, { delivery }, {
      force: true,
      reason: due.reason,
      requestedAt,
    });
    nextState = withDeliveryReminder(result.state, delivery.id, {
      level: due.level,
      queuedAt: requestedAt,
      error: '',
    });
    alreadyQueuedDeliveryIds.add(cleanText(delivery.id));
    queued.push({ deliveryId: delivery.id, level: due.level, reason: due.reason });
  }

  return { state: nextState, queued };
}

async function processNotificationOutboxState(state, options = {}) {
  const limit = Math.max(1, Number.parseInt(options.limit ?? '5', 10) || 5);
  const onlyDeliveryId = cleanText(options.deliveryId);
  const now = Date.now();
  let nextState = {
    ...state,
    notificationOutbox: (state.notificationOutbox ?? []).map(normalizeNotificationOutboxItem),
  };
  const processed = [];

  const candidates = nextState.notificationOutbox
    .filter((item) => ['pending', 'failed'].includes(item.status))
    .filter((item) => !onlyDeliveryId || item.deliveryId === onlyDeliveryId)
    .filter((item) => !item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now)
    .slice(0, limit);

  for (const item of candidates) {
    const delivery = (nextState.deliveries ?? []).find((entry) => cleanText(entry.id) === item.deliveryId);
    if (!delivery) {
      const failedItem = {
        ...item,
        status: 'failed',
        attempts: item.attempts + 1,
        lastAttemptAt: nowIso(),
        nextAttemptAt: new Date(Date.now() + notificationRetryDelayMs(item.attempts + 1)).toISOString(),
        error: 'Entrega nao encontrada para envio de e-mail.',
      };
      nextState = {
        ...nextState,
        notificationOutbox: nextState.notificationOutbox.map((entry) => entry.id === item.id ? failedItem : entry),
      };
      processed.push({ outboxId: item.id, deliveryId: item.deliveryId, notification: { status: 'failed', error: failedItem.error } });
      continue;
    }

    const attemptedAt = nowIso();
    try {
      const info = await sendDeliveryEmail({ ...delivery, notificationReason: item.reason });
      const notification = {
        status: 'sent',
        requestedAt: cleanText(delivery.notificationRequestedAt) || item.requestedAt || attemptedAt,
        sentAt: nowIso(),
        error: '',
        messageId: cleanText(info?.messageId),
      };
      const sentItem = {
        ...item,
        status: 'sent',
        attempts: item.attempts + 1,
        lastAttemptAt: attemptedAt,
        nextAttemptAt: '',
        sentAt: notification.sentAt,
        error: '',
        messageId: notification.messageId,
      };
      const deliveryPatch = isReminderReason(item.reason)
        ? {
            ...delivery,
            reminderLevel: Math.max(Number(delivery.reminderLevel) || 0, reminderLevelFromReason(item.reason)),
            reminderLastSentAt: notification.sentAt,
            reminderError: '',
          }
        : delivery;
      nextState = withAudit(
        {
          ...withDeliveryNotification(nextState, deliveryPatch, notification),
          notificationOutbox: nextState.notificationOutbox.map((entry) => entry.id === item.id ? sentItem : entry),
        },
        'delivery-email-sent',
        `PIN e QR enviados para ${delivery.recipientEmail}.`,
        { deliveryId: delivery.id, recipientEmail: delivery.recipientEmail, outboxId: item.id }
      );
      processed.push({ outboxId: item.id, deliveryId: delivery.id, notification });
    } catch (error) {
      const notification = {
        status: 'failed',
        requestedAt: cleanText(delivery.notificationRequestedAt) || item.requestedAt || attemptedAt,
        sentAt: '',
        error: error.message || 'Falha ao enviar e-mail.',
        messageId: '',
      };
      const failedItem = {
        ...item,
        status: item.attempts + 1 >= NOTIFICATION_OUTBOX_MAX_ATTEMPTS ? 'failed' : 'pending',
        attempts: item.attempts + 1,
        lastAttemptAt: attemptedAt,
        nextAttemptAt: new Date(Date.now() + notificationRetryDelayMs(item.attempts + 1)).toISOString(),
        error: notification.error,
      };
      const deliveryPatch = isReminderReason(item.reason)
        ? {
            ...delivery,
            reminderLevel: Math.max(Number(delivery.reminderLevel) || 0, reminderLevelFromReason(item.reason)),
            reminderError: notification.error,
          }
        : delivery;
      nextState = withAudit(
        {
          ...withDeliveryNotification(nextState, deliveryPatch, notification),
          notificationOutbox: nextState.notificationOutbox.map((entry) => entry.id === item.id ? failedItem : entry),
        },
        'delivery-email-failed',
        `Falha ao enviar PIN e QR para ${delivery.recipientEmail || 'apartamento sem e-mail'}.`,
        { deliveryId: delivery.id, recipientEmail: delivery.recipientEmail, error: notification.error, outboxId: item.id }
      );
      processed.push({ outboxId: item.id, deliveryId: delivery.id, notification });
    }
  }

  return { state: nextState, processed };
}

async function processNotificationOutboxFromDisk(options = {}) {
  if (notificationOutboxInFlight) return;
  notificationOutboxInFlight = true;
  try {
    const lockerId = normalizeLockerId(options.lockerId);
    const tenantId = normalizeTenantId(options.tenantId);
    const current = await readFreshState(lockerId, tenantId);
    const reminders = queueDueDeliveryReminders(current);
    const result = await processNotificationOutboxState(reminders.state, options);
    if (result.processed.length > 0 || reminders.queued.length > 0) {
      await writeState(result.state, lockerId, tenantId);
    }
  } catch (error) {
    console.error(`[PREDDITA] Falha no outbox de e-mail: ${error.message}`);
  } finally {
    notificationOutboxInFlight = false;
  }
}

function mergeDeviceDeliveries(currentDeliveries = [], incomingDeliveries = []) {
  const currentById = new Map(currentDeliveries.map((delivery) => [cleanText(delivery.id), delivery]));

  return incomingDeliveries.map((delivery) => {
    const current = currentById.get(cleanText(delivery.id));
    if (!current) return delivery;
    const preserved = {
      labelPhotoDataUrl: cleanText(delivery.labelPhotoDataUrl) || cleanText(current.labelPhotoDataUrl),
      labelPhotoCapturedAt: cleanText(delivery.labelPhotoCapturedAt) || cleanText(current.labelPhotoCapturedAt),
      labelOcrStatus: cleanText(delivery.labelOcrStatus) || cleanText(current.labelOcrStatus),
      labelOcrText: cleanText(delivery.labelOcrText) || cleanText(current.labelOcrText),
      labelOcrApartment: cleanText(delivery.labelOcrApartment) || cleanText(current.labelOcrApartment),
      labelOcrConfidence: Number.isFinite(Number(delivery.labelOcrConfidence))
        ? Number(delivery.labelOcrConfidence)
        : Number.isFinite(Number(current.labelOcrConfidence))
        ? Number(current.labelOcrConfidence)
        : null,
      labelProofRequired: Boolean(delivery.labelProofRequired || current.labelProofRequired),
      reminderLevel: Math.max(Number(delivery.reminderLevel) || 0, Number(current.reminderLevel) || 0),
      reminderLastQueuedAt: cleanText(delivery.reminderLastQueuedAt) || cleanText(current.reminderLastQueuedAt),
      reminderLastSentAt: cleanText(delivery.reminderLastSentAt) || cleanText(current.reminderLastSentAt),
      reminderError: cleanText(delivery.reminderError) || cleanText(current.reminderError),
    };
    if (cleanText(current.notificationStatus) === 'sent' && cleanText(current.notificationSentAt)) {
      return {
        ...delivery,
        ...preserved,
        notificationStatus: current.notificationStatus,
        notificationRequestedAt: current.notificationRequestedAt,
        notificationSentAt: current.notificationSentAt,
        notificationError: '',
        notificationMessageId: current.notificationMessageId,
      };
    }

    return {
      ...delivery,
      ...preserved,
      notificationStatus: cleanText(delivery.notificationStatus) || cleanText(current.notificationStatus),
      notificationRequestedAt: cleanText(delivery.notificationRequestedAt) || cleanText(current.notificationRequestedAt),
      notificationSentAt: cleanText(delivery.notificationSentAt) || cleanText(current.notificationSentAt),
      notificationError: cleanText(delivery.notificationError) || cleanText(current.notificationError),
      notificationMessageId: cleanText(delivery.notificationMessageId) || cleanText(current.notificationMessageId),
    };
  });
}

async function notifyDeliveryStored(state, payload, options = {}) {
  const queued = queueDeliveryNotification(state, payload, {
    ...options,
    reason: options.reason || (options.force ? 'manual-resend' : 'delivery-stored'),
  });
  const delivery = normalizeDeliveryPayload(payload);
  if (queued.notification?.status !== 'pending' || !delivery.id) {
    return queued;
  }

  const processed = await processNotificationOutboxState(queued.state, {
    limit: 1,
    deliveryId: delivery.id,
  });
  const processedItem = processed.processed.find((item) => item.deliveryId === delivery.id);
  return {
    state: processed.state,
    notification: processedItem?.notification ?? queued.notification,
  };
}

function normalizeDeviceEvent(raw = {}) {
  const event = raw && typeof raw === 'object' ? raw : {};
  return {
    id: cleanText(event.id),
    type: cleanText(event.type),
    payload: event.payload && typeof event.payload === 'object' ? event.payload : {},
    occurredAt: cleanText(event.occurredAt || event.at) || nowIso(),
    queuedAt: cleanText(event.queuedAt),
    attempts: Number.isFinite(Number(event.attempts)) ? Math.max(0, Number(event.attempts)) : 0,
  };
}

function withProcessedDeviceEvent(state, event) {
  return {
    ...state,
    processedDeviceEvents: [
      {
        id: event.id,
        type: event.type,
        occurredAt: event.occurredAt,
        processedAt: nowIso(),
      },
      ...(state.processedDeviceEvents ?? []).filter((item) => cleanText(item.id) !== event.id),
    ].slice(0, MAX_PROCESSED_DEVICE_EVENTS),
  };
}

function upsertDeliveryRecord(deliveries = [], delivery) {
  const normalizedDelivery = normalizeDeliveryPayload({ delivery });
  const deliveryId = cleanText(normalizedDelivery.id);
  let found = false;
  const nextDeliveries = deliveries.map((item) => {
    if (cleanText(item.id) !== deliveryId) return item;
    found = true;
    return { ...item, ...normalizedDelivery };
  });

  return found ? nextDeliveries : [normalizedDelivery, ...nextDeliveries];
}

/*
 * Eventos vindos do armario.
 *
 * Este endpoint e o "diario de bordo" offline do locker: quando o Android fica
 * sem internet ele continua abrindo portas localmente, grava os eventos em fila
 * e reenvia depois. Cada evento deve ter id estavel para que o servidor possa
 * aceitar replays sem duplicar e-mails, retiradas ou auditoria.
 */
function releaseDoorInState(state, delivery, source, occurredAt) {
  const deliveryId = cleanText(delivery.id);
  const doorNumber = Number.parseInt(delivery.door, 10);
  return {
    ...state,
    doors: (state.doors ?? []).map((door) =>
      Number.parseInt(door.channel, 10) === doorNumber
        ? { ...door, occupancy: 'free', delivery: null, lastSeenAt: nowIso() }
        : door
    ),
    deliveries: upsertDeliveryRecord(state.deliveries, {
      ...delivery,
      status: 'collected',
      pickupOpenedAt: cleanText(delivery.pickupOpenedAt) || occurredAt,
      collectedAt: cleanText(delivery.collectedAt) || occurredAt,
      collectionSource: source,
    }),
  };
}

async function applyDeviceEvent(state, event) {
  if (!event.id || !event.type) {
    throw new Error('Evento sem id ou tipo.');
  }

  const processed = new Set((state.processedDeviceEvents ?? []).map((item) => cleanText(item.id)));
  if (processed.has(event.id)) {
    return { state, notification: null, duplicate: true };
  }

  if (event.type === 'delivery-stored') {
    const delivery = normalizeDeliveryPayload(event.payload.delivery ?? event.payload);
    if (!delivery.id) {
      throw new Error('Evento de entrega sem identificador.');
    }

    let nextState = withAudit(
      {
        ...state,
        deliveries: upsertDeliveryRecord(state.deliveries, {
          ...delivery,
          status: 'stored',
          depositedAt: cleanText(delivery.depositedAt) || event.occurredAt,
        }),
      },
      'device-delivery-stored',
      `Entrega sincronizada pelo armario para ${delivery.unit || delivery.recipientName || 'apartamento'}.`,
      { eventId: event.id, deliveryId: delivery.id, door: delivery.door }
    );

    let notification = null;
    const shouldSendEmail = event.payload.sendEmail !== false && isValidEmail(delivery.recipientEmail);
    if (shouldSendEmail) {
      const result = queueDeliveryNotification(nextState, {
        delivery: {
          ...delivery,
          status: 'stored',
          depositedAt: cleanText(delivery.depositedAt) || event.occurredAt,
        },
      }, {
        requestedAt: event.occurredAt,
        reason: 'device-delivery-stored',
      });
      nextState = result.state;
      notification = result.notification;
    } else {
      notification = {
        status: delivery.recipientEmail ? 'failed' : 'skipped',
        requestedAt: event.occurredAt,
        sentAt: '',
        error: delivery.recipientEmail ? 'Apartamento sem e-mail valido cadastrado.' : 'Apartamento sem e-mail cadastrado.',
        messageId: '',
      };
      nextState = withDeliveryNotification(nextState, delivery, notification);
    }

    return { state: withProcessedDeviceEvent(nextState, event), notification };
  }

  if (event.type === 'delivery-collected') {
    const delivery = normalizeDeliveryPayload(event.payload.delivery ?? event.payload);
    if (!delivery.id) {
      throw new Error('Evento de retirada sem identificador.');
    }

    const nextState = withAudit(
      releaseDoorInState(state, delivery, cleanText(event.payload.source) || 'locker', event.occurredAt),
      'device-delivery-collected',
      `Retirada sincronizada pelo armario para ${delivery.unit || delivery.recipientName || 'apartamento'}.`,
      { eventId: event.id, deliveryId: delivery.id, door: delivery.door }
    );
    return { state: withProcessedDeviceEvent(nextState, event), notification: null };
  }

  if (event.type === 'door-opened') {
    const door = Number.parseInt(event.payload.door, 10);
    const nextState = withAudit(
      state,
      'device-door-opened',
      Number.isInteger(door)
        ? `Porta ${door} acionada localmente no armario.`
        : 'Porta acionada localmente no armario.',
      { eventId: event.id, ...event.payload }
    );
    return { state: withProcessedDeviceEvent(nextState, event), notification: null };
  }

  const nextState = withAudit(
    state,
    'device-event',
    `Evento ${event.type} recebido do armario.`,
    { eventId: event.id, payload: event.payload }
  );
  return { state: withProcessedDeviceEvent(nextState, event), notification: null };
}

async function applyDeviceEvents(state, rawEvents = []) {
  const events = Array.isArray(rawEvents)
    ? rawEvents.map(normalizeDeviceEvent).filter((event) => event.id && event.type)
    : [];
  let nextState = state;
  const acceptedIds = [];
  const failedEvents = [];
  const notifications = [];

  for (const event of events.slice(0, MAX_DEVICE_EVENTS_PER_BATCH)) {
    try {
      const result = await applyDeviceEvent(nextState, event);
      nextState = result.state;
      acceptedIds.push(event.id);
      if (result.notification) {
        notifications.push({
          eventId: event.id,
          deliveryId: cleanText(event.payload?.delivery?.id || event.payload?.id),
          notification: result.notification,
          duplicate: Boolean(result.duplicate),
        });
      }
    } catch (error) {
      failedEvents.push({
        id: event.id,
        type: event.type,
        error: error.message || 'Falha ao processar evento.',
      });
    }
  }

  return { state: nextState, acceptedIds, failedEvents, notifications };
}

function readBody(request) {
  if (request.predditaBodyPromise) {
    return request.predditaBodyPromise;
  }

  request.predditaBodyPromise = new Promise((resolve, reject) => {
    let body = '';
    let bodyBytes = 0;
    let rejected = false;
    request.on('data', (chunk) => {
      if (rejected) return;
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_JSON_BODY_BYTES) {
        rejected = true;
        reject(new Error('Payload muito grande.'));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      if (rejected) return;
      request.predditaRawBody = body;
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (_error) {
        reject(new Error('JSON invalido.'));
      }
    });
  });
  return request.predditaBodyPromise;
}

function responseCorsHeaders(response) {
  const origin = response.predditaCorsOrigin ?? '*';
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-admin-token,x-csrf-token,x-device-key,x-locker-id,x-preddita-timestamp,x-preddita-nonce,x-preddita-content-sha256,x-preddita-signature',
    ...(origin !== '*' ? { 'access-control-allow-credentials': 'true', vary: 'Origin' } : {}),
  };
}

function responseSecurityHeaders() {
  return {
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    ...(IS_PRODUCTION ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

function sendJson(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...responseSecurityHeaders(),
    ...responseCorsHeaders(response),
    'x-preddita-version': APP_VERSION,
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, status, message) {
  sendJson(response, status, { ok: false, error: message });
}

function sendText(response, status, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    ...responseSecurityHeaders(),
    ...responseCorsHeaders(response),
    'x-preddita-version': APP_VERSION,
    ...extraHeaders,
  });
  response.end(text);
}

function csvCell(value) {
  const text = cleanText(value).replaceAll('"', '""');
  return /[",\n\r;]/.test(text) ? `"${text}"` : text;
}

function toCsv(headers, rows) {
  return [
    headers.map(csvCell).join(';'),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(';')),
  ].join('\n');
}

function createLegacyAdminAuth(role, username, name) {
  const permissions = getAdminRolePermissions(role);
  const user = {
    id: `legacy-${username}`,
    username,
    name,
    role,
    tenantId: DEFAULT_TENANT_ID,
    lockerIds: role === 'super_admin' ? ['*'] : [DEFAULT_LOCKER_ID],
    permissions,
  };
  return {
    type: 'legacy-token',
    session: {
      id: `legacy-${role}`,
      csrfToken: '',
      user,
      createdAt: '',
      expiresAt: '',
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    },
  };
}

async function getAdminAuth(request) {
  const cookieSession = await adminSessionStore.get(request.headers.cookie);
  if (cookieSession) {
    return { type: 'session-cookie', session: cookieSession };
  }
  if (!ALLOW_LEGACY_ADMIN_TOKENS) return null;

  const token = request.headers['x-admin-token'];
  if (safeTokenEquals(token, SUPER_ADMIN_TOKEN)) {
    return createLegacyAdminAuth('super_admin', 'legacy-preddita', 'Admin Geral PREDDITA');
  }

  if (safeTokenEquals(token, ADMIN_TOKEN)) {
    return createLegacyAdminAuth('sindico', 'legacy-sindico', 'Painel do Sindico');
  }

  return null;
}

function hasValidAdminCsrf(request, adminAuth) {
  if (adminAuth?.type === 'legacy-token') return true;
  return safeTokenEquals(request.headers['x-csrf-token'], adminAuth?.session?.csrfToken);
}

function isRequestOriginAllowed(request) {
  const origin = cleanText(request.headers.origin);
  return !origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin);
}

function adminActor(adminAuth) {
  return adminAuth?.session?.user?.username || 'administrador';
}

function hasAdminPermission(adminAuth, permission) {
  return Boolean(adminAuth?.session?.user?.permissions?.[permission]);
}

function getDeviceKey(request) {
  const lockerId = getRequestLockerId(request);
  return DEVICE_KEYS.get(lockerId) || (lockerId === DEFAULT_LOCKER_ID ? DEVICE_KEY : '');
}

function createDeviceRequestCanonical(request, lockerId, timestamp, nonce, contentSha256) {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  return [
    'PREDDITA-HMAC-V1',
    String(request.method || 'GET').toUpperCase(),
    `${url.pathname}${url.search}`,
    lockerId,
    timestamp,
    nonce,
    contentSha256,
  ].join('\n');
}

function reserveDeviceNonce(lockerId, nonce, now) {
  for (const [key, expiresAt] of deviceAuthNonces) {
    if (expiresAt <= now) deviceAuthNonces.delete(key);
  }

  const key = `${lockerId}:${nonce}`;
  if ((deviceAuthNonces.get(key) ?? 0) > now) {
    return false;
  }
  deviceAuthNonces.set(key, now + DEVICE_SIGNATURE_TTL_MS);

  while (deviceAuthNonces.size > MAX_DEVICE_AUTH_NONCES) {
    const oldest = deviceAuthNonces.keys().next().value;
    if (!oldest) break;
    deviceAuthNonces.delete(oldest);
  }
  return true;
}

function hasValidDeviceSignature(request) {
  const lockerId = getRequestLockerId(request);
  const expectedKey = getDeviceKey(request);
  const timestamp = cleanText(request.headers['x-preddita-timestamp']);
  const nonce = cleanText(request.headers['x-preddita-nonce']);
  const contentSha256 = cleanText(request.headers['x-preddita-content-sha256']).toLowerCase();
  const signatureHeader = cleanText(request.headers['x-preddita-signature']);
  const signature = signatureHeader.startsWith('v1=') ? signatureHeader.slice(3).toLowerCase() : '';
  const timestampMs = Number.parseInt(timestamp, 10);
  const now = Date.now();

  if (
    !expectedKey ||
    !/^\d{10,16}$/.test(timestamp) ||
    !Number.isSafeInteger(timestampMs) ||
    Math.abs(now - timestampMs) > DEVICE_SIGNATURE_TTL_MS ||
    !/^[A-Za-z0-9._:-]{16,128}$/.test(nonce) ||
    !/^[a-f0-9]{64}$/.test(contentSha256) ||
    !/^[a-f0-9]{64}$/.test(signature)
  ) {
    return false;
  }

  const actualContentSha256 = createHash('sha256')
    .update(String(request.predditaRawBody ?? ''), 'utf8')
    .digest('hex');
  if (!safeTokenEquals(contentSha256, actualContentSha256)) {
    return false;
  }

  const canonical = createDeviceRequestCanonical(request, lockerId, timestamp, nonce, contentSha256);
  const expectedSignature = createHmac('sha256', expectedKey).update(canonical, 'utf8').digest('hex');
  if (!safeTokenEquals(signature, expectedSignature)) {
    return false;
  }

  return reserveDeviceNonce(lockerId, nonce, now);
}

function hasDeviceAuth(request) {
  if (DEVICE_AUTH_MODE === 'hmac') {
    return hasValidDeviceSignature(request);
  }
  if (DEVICE_AUTH_MODE === 'dual' && request.headers['x-preddita-signature']) {
    return hasValidDeviceSignature(request);
  }

  const expectedKey = getDeviceKey(request);
  return DEVICE_AUTH_MODE !== 'hmac'
    && Boolean(expectedKey)
    && safeTokenEquals(request.headers['x-device-key'], expectedKey);
}

function routePath(url) {
  return new URL(url, `http://localhost:${PORT}`).pathname;
}

function getRequestLockerId(request) {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  return cleanText(request.headers['x-locker-id']) || cleanText(url.searchParams.get('lockerId')) || DEFAULT_LOCKER_ID;
}

function bodyLockerId(body) {
  return cleanText(body?.lockerId || body?.device?.lockerId || body?.tenant?.lockerId);
}

function validateDeviceLocker(state, request, body = null) {
  const requestLockerId = getRequestLockerId(request);
  const payloadLockerId = body ? bodyLockerId(body) : '';
  const expectedLockerId = cleanText(state.tenant?.lockerId) || DEFAULT_LOCKER_ID;
  const actualLockerId = payloadLockerId || requestLockerId;

  if (actualLockerId !== expectedLockerId) {
    return {
      ok: false,
      error: `Locker ${actualLockerId} nao corresponde ao locker configurado neste servidor.`,
    };
  }

  return { ok: true, lockerId: actualLockerId };
}

function getClientKey(request) {
  const forwarded = TRUST_PROXY ? cleanText(request.headers['x-forwarded-for']).split(',')[0] : '';
  return forwarded || request.socket.remoteAddress || 'local';
}

const rateBuckets = new Map();

function checkRateLimit(request, bucketName, limit) {
  const now = Date.now();
  const windowMs = 60_000;
  const key = `${bucketName}:${getClientKey(request)}`;
  const bucket = rateBuckets.get(key) ?? { count: 0, resetAt: now + windowMs };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }

  bucket.count += 1;
  rateBuckets.set(key, bucket);
  return bucket.count <= limit;
}

function applyCors(request, response) {
  const origin = cleanText(request.headers.origin);
  if (!origin) {
    response.predditaCorsOrigin = '*';
    return;
  }
  if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
    response.predditaCorsOrigin = origin;
    return;
  }
  response.predditaCorsOrigin = 'null';
}

function serveStatic(request, response) {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const normalized = normalize(join(PUBLIC_DIR, requestedPath));
  const insidePublicDir = normalized === PUBLIC_DIR || normalized.startsWith(`${PUBLIC_DIR}${sep}`);

  if (!insidePublicDir || !existsSync(normalized) || !statSync(normalized).isFile()) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  const typeMap = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };
  response.writeHead(200, {
    'content-type': typeMap[extname(normalized)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    ...responseSecurityHeaders(),
  });
  response.end(readFileSync(normalized));
}

async function handleApi(request, response) {
  const path = routePath(request.url);
  const method = request.method ?? 'GET';

  if (method === 'OPTIONS') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (path === '/api/healthz') {
    sendJson(response, 200, { ok: true, appVersion: APP_VERSION, schemaVersion: SCHEMA_VERSION, at: nowIso() });
    return;
  }

  const isAuthPath = path.startsWith('/api/auth');
  const isAdminPath = path.startsWith('/api/admin');
  const isDevicePath = path.startsWith('/api/device');

  if ((isAuthPath || isAdminPath) && !isRequestOriginAllowed(request)) {
    sendError(response, 403, 'Origem nao autorizada para o painel administrativo.');
    return;
  }

  if (method === 'POST' && path === '/api/auth/login') {
    if (!checkRateLimit(request, 'admin-login', ADMIN_LOGIN_RATE_LIMIT_PER_MINUTE)) {
      sendError(response, 429, 'Muitas tentativas de login. Aguarde um minuto.');
      return;
    }
    const body = await readBody(request);
    const user = authenticateAdminUser(adminUsers, body.username, body.password);
    if (!user) {
      sendError(response, 401, 'Usuario ou senha invalidos.');
      return;
    }
    if (isAdminMfaEnabledFor(user)) {
      const mfa = await beginAdminMfaLogin(user);
      console.log(JSON.stringify({
        level: 'info',
        event: mfa.enrollment ? 'admin-mfa-enrollment-started' : 'admin-mfa-challenge-started',
        username: user.username,
        role: user.role,
        client: getClientKey(request),
        at: nowIso(),
      }));
      sendJson(response, 200, { ok: true, mfa });
      return;
    }
    const created = await adminSessionStore.create(user);
    console.log(JSON.stringify({
      level: 'info',
      event: 'admin-login',
      username: user.username,
      role: user.role,
      client: getClientKey(request),
      at: nowIso(),
    }));
    sendJson(
      response,
      200,
      { ok: true, session: toPublicAdminSession(created.session, { includeCsrf: true }) },
      { 'set-cookie': created.cookie }
    );
    return;
  }

  if (method === 'POST' && path === '/api/auth/mfa/verify') {
    if (!checkRateLimit(request, 'admin-mfa', ADMIN_LOGIN_RATE_LIMIT_PER_MINUTE)) {
      sendError(response, 429, 'Muitas tentativas de MFA. Aguarde um minuto.');
      return;
    }
    if (!isPostgresStorage() || !ADMIN_MFA_ENCRYPTION_KEY) {
      sendError(response, 404, 'MFA nao esta habilitado neste ambiente.');
      return;
    }
    const body = await readBody(request);
    const challengeToken = cleanText(body.challengeToken);
    const code = cleanText(body.code);
    const recoveryCode = cleanText(body.recoveryCode);
    if (!/^[A-Za-z0-9_-]{40,80}$/.test(challengeToken)) {
      sendError(response, 400, 'Desafio MFA invalido. Entre novamente.');
      return;
    }
    if (!recoveryCode && !/^\d{6}$/.test(code)) {
      sendError(response, 400, 'Informe o codigo de 6 digitos do autenticador.');
      return;
    }
    if (recoveryCode && recoveryCode.length > 40) {
      sendError(response, 400, 'Codigo de recuperacao invalido.');
      return;
    }

    const verified = await completeAdminMfaLogin({ challengeToken, code, recoveryCode });
    if (!verified.ok) {
      sendError(response, verified.status, verified.error);
      return;
    }
    const created = await adminSessionStore.create(verified.user);
    console.log(JSON.stringify({
      level: 'info',
      event: verified.enrollment ? 'admin-mfa-enrolled' : 'admin-mfa-verified',
      username: verified.user.username,
      role: verified.user.role,
      method: recoveryCode ? 'recovery-code' : 'totp',
      client: getClientKey(request),
      at: nowIso(),
    }));
    sendJson(
      response,
      200,
      {
        ok: true,
        session: toPublicAdminSession(created.session, { includeCsrf: true }),
        mfa: {
          enrollmentComplete: verified.enrollment,
          recoveryCodes: verified.recoveryCodes,
        },
      },
      { 'set-cookie': created.cookie }
    );
    return;
  }

  if (method === 'GET' && path === '/api/auth/session') {
    const adminAuth = await getAdminAuth(request);
    if (!adminAuth) {
      sendError(response, 401, 'Sessao administrativa ausente ou expirada.');
      return;
    }
    sendJson(response, 200, {
      ok: true,
      session: toPublicAdminSession(adminAuth.session, { includeCsrf: true }),
    });
    return;
  }

  if (method === 'POST' && path === '/api/auth/logout') {
    const adminAuth = await getAdminAuth(request);
    if (!adminAuth) {
      sendError(response, 401, 'Sessao administrativa ausente ou expirada.');
      return;
    }
    if (!hasValidAdminCsrf(request, adminAuth)) {
      sendError(response, 403, 'Token CSRF invalido. Atualize a pagina e tente novamente.');
      return;
    }
    const clearedCookie = await adminSessionStore.destroy(request.headers.cookie);
    console.log(JSON.stringify({
      level: 'info',
      event: 'admin-logout',
      username: adminActor(adminAuth),
      client: getClientKey(request),
      at: nowIso(),
    }));
    sendJson(response, 200, { ok: true }, { 'set-cookie': clearedCookie });
    return;
  }

  if (isAuthPath) {
    sendError(response, 404, 'Rota de autenticacao nao encontrada.');
    return;
  }

  if (isAdminPath && !checkRateLimit(request, 'admin', ADMIN_RATE_LIMIT_PER_MINUTE)) {
    sendError(response, 429, 'Muitas requisicoes administrativas em pouco tempo.');
    return;
  }

  if (isDevicePath && !checkRateLimit(request, 'device', DEVICE_RATE_LIMIT_PER_MINUTE)) {
    sendError(response, 429, 'Muitas requisicoes do dispositivo em pouco tempo.');
    return;
  }

  const adminAuth = isAdminPath ? await getAdminAuth(request) : null;
  if (isAdminPath && !adminAuth) {
    sendError(response, 401, 'Sessao administrativa ausente ou expirada.');
    return;
  }
  if (isAdminPath && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !hasValidAdminCsrf(request, adminAuth)) {
    sendError(response, 403, 'Token CSRF invalido. Atualize a pagina e tente novamente.');
    return;
  }

  if (isDevicePath) {
    try {
      await readBody(request);
    } catch (error) {
      sendError(response, 400, error.message || 'Corpo da requisicao invalido.');
      return;
    }
    if (!hasDeviceAuth(request)) {
      sendError(response, 401, 'Autenticacao do dispositivo invalida.');
      return;
    }
  }

  const requestLockerId = getRequestLockerId(request);
  if (isAdminPath && !adminUserCanAccessLocker(adminAuth.session.user, requestLockerId, DEFAULT_TENANT_ID)) {
    sendError(response, 403, 'Este usuario nao possui acesso ao locker solicitado.');
    return;
  }
  const adminSession = isAdminPath ? toPublicAdminSession(adminAuth.session) : null;
  const state = await readFreshState(requestLockerId);
  if (isDevicePath) {
    const lockerValidation = validateDeviceLocker(state, request);
    if (!lockerValidation.ok) {
      sendError(response, 403, lockerValidation.error);
      return;
    }
  }

  if (method === 'GET' && path === '/api/admin/state') {
    sendJson(response, 200, { ok: true, state: decorateStateForAdmin(state, adminSession) });
    return;
  }

  if (method === 'GET' && path === '/api/admin/export/residents.csv') {
    if (!hasAdminPermission(adminAuth, 'canExportData')) {
      sendError(response, 403, 'Este papel nao pode exportar dados pessoais.');
      return;
    }
    sendText(
      response,
      200,
      toCsv(
        ['id', 'apartment', 'building', 'floor', 'phone', 'email', 'createdAt', 'updatedAt'],
        state.residents ?? []
      ),
      'text/csv; charset=utf-8'
    );
    return;
  }

  if (method === 'GET' && path === '/api/admin/export/deliveries.csv') {
    if (!hasAdminPermission(adminAuth, 'canExportData')) {
      sendError(response, 403, 'Este papel nao pode exportar dados pessoais.');
      return;
    }
    sendText(
      response,
      200,
      toCsv(
        ['id', 'recipientName', 'recipientEmail', 'unit', 'door', 'size', 'pin', 'status', 'notificationStatus', 'createdAt', 'depositedAt', 'collectedAt', 'expiresAt'],
        state.deliveries ?? []
      ),
      'text/csv; charset=utf-8'
    );
    return;
  }

  if (method === 'GET' && path === '/api/admin/export/audit.csv') {
    if (!hasAdminPermission(adminAuth, 'canExportData')) {
      sendError(response, 403, 'Este papel nao pode exportar dados.');
      return;
    }
    sendText(
      response,
      200,
      toCsv(
        ['id', 'kind', 'message', 'at'],
        state.auditTrail ?? []
      ),
      'text/csv; charset=utf-8'
    );
    return;
  }

  if (method === 'POST' && path === '/api/admin/residents') {
    if (!hasAdminPermission(adminAuth, 'canManageApartments')) {
      sendError(response, 403, 'Este papel nao pode cadastrar apartamentos.');
      return;
    }
    const body = await readBody(request);
    const resident = normalizeResident(body);
    if (!resident.apartment) {
      sendError(response, 400, 'Preencha o apartamento.');
      return;
    }
    if (resident.email && !isValidEmail(resident.email)) {
      sendError(response, 400, 'Informe um e-mail valido ou deixe o campo em branco.');
      return;
    }
    const next = withAudit(
      withResidentsRevision(state, [resident, ...(state.residents ?? [])]),
      'resident-created',
      `${residentApartmentLabel(resident)} cadastrado.`,
      { residentId: resident.id, actor: adminActor(adminAuth) }
    );
    await writeState(next, requestLockerId);
    sendJson(response, 201, { ok: true, resident });
    return;
  }

  const residentMatch = path.match(/^\/api\/admin\/residents\/([^/]+)$/);
  if (residentMatch && method === 'PUT') {
    if (!hasAdminPermission(adminAuth, 'canManageApartments')) {
      sendError(response, 403, 'Este papel nao pode alterar apartamentos.');
      return;
    }
    const body = await readBody(request);
    const residentId = decodeURIComponent(residentMatch[1]);
    const previous = (state.residents ?? []).find((item) => item.id === residentId);
    if (!previous) {
      sendError(response, 404, 'Apartamento nao encontrado.');
      return;
    }
    const resident = normalizeResident(body, previous);
    if (!resident.apartment) {
      sendError(response, 400, 'Preencha o apartamento.');
      return;
    }
    if (resident.email && !isValidEmail(resident.email)) {
      sendError(response, 400, 'Informe um e-mail valido ou deixe o campo em branco.');
      return;
    }
    const next = withAudit(
      withResidentsRevision(
        state,
        state.residents.map((item) => (item.id === residentId ? resident : item))
      ),
      'resident-updated',
      `Cadastro de ${residentApartmentLabel(resident)} atualizado.`,
      { residentId, actor: adminActor(adminAuth) }
    );
    await writeState(next, requestLockerId);
    sendJson(response, 200, { ok: true, resident });
    return;
  }

  if (residentMatch && method === 'DELETE') {
    if (!hasAdminPermission(adminAuth, 'canManageApartments')) {
      sendError(response, 403, 'Este papel nao pode remover apartamentos.');
      return;
    }
    const residentId = decodeURIComponent(residentMatch[1]);
    const previous = (state.residents ?? []).find((item) => item.id === residentId);
    const next = withAudit(
      withResidentsRevision(state, (state.residents ?? []).filter((item) => item.id !== residentId)),
      'resident-deleted',
      previous ? `${residentApartmentLabel(previous)} removido.` : 'Apartamento removido.',
      { residentId, actor: adminActor(adminAuth) }
    );
    await writeState(next, requestLockerId);
    sendJson(response, 200, { ok: true });
    return;
  }

  const openDoorMatch = path.match(/^\/api\/admin\/doors\/(\d+)\/open$/);
  if (openDoorMatch && method === 'POST') {
    if (!hasAdminPermission(adminAuth, 'canOperateLocker')) {
      sendError(response, 403, 'Este papel nao pode operar portas remotamente.');
      return;
    }
    const door = Number.parseInt(openDoorMatch[1], 10);
    const body = await readBody(request);
    const creationResult = await withLockerStateMutation(
      requestLockerId,
      state.tenant?.tenantId ?? DEFAULT_TENANT_ID,
      async () => {
        const current = await readFreshState(requestLockerId);
        const configuredDoorCount = Math.max(
          1,
          Number.parseInt(current.device?.doorCount || current.doors?.length || 24, 10)
        );
        if (!Number.isInteger(door) || door < 1 || door > configuredDoorCount) {
          return { status: 400, error: 'Porta invalida.' };
        }

        const blockedReason = getRemoteOpenBlockReason(current, door);
        if (blockedReason) {
          return { status: 409, error: blockedReason };
        }
        if (!checkRateLimit(request, 'remote-open', OPEN_RATE_LIMIT_PER_MINUTE)) {
          return { status: 429, error: 'Limite de abertura remota atingido. Aguarde um minuto.' };
        }

        const createdAt = nowIso();
        const command = {
          id: createId('cmd'),
          lockerId: current.tenant?.lockerId ?? DEFAULT_LOCKER_ID,
          type: 'openDoor',
          door,
          reason: cleanText(body.reason) || 'Abertura remota pelo sindico.',
          status: 'pending',
          requestedBy: adminActor(adminAuth),
          createdAt,
          leaseId: '',
          leasedAt: '',
          leaseExpiresAt: '',
          acknowledgedAt: '',
          executionId: '',
          deliveryAttempt: 0,
          completedAt: '',
          result: null,
          timeline: [
            { status: 'pending', at: createdAt, detail: 'Comando criado no painel online.' },
          ],
        };
        const auditMeta = { commandId: command.id, door, actor: adminActor(adminAuth) };
        if (isPostgresStorage()) {
          const tenantId = normalizeTenantId(current.tenant?.tenantId ?? DEFAULT_TENANT_ID);
          const lockerId = normalizeLockerId(requestLockerId);
          const pool = await ensurePostgres();
          const created = await createOperationalCommand(pool, {
            tenantId,
            lockerId,
            schemaVersion: SCHEMA_VERSION,
            command,
            loadState: (client) => readNormalizedPostgresState(client, lockerId, tenantId),
            buildState: (lockedState) => withAudit(
              lockedState,
              'remote-open-requested',
              `Abertura remota solicitada para a porta ${door}.`,
              auditMeta
            ),
          });
          if (!created.created) {
            return { status: 409, error: 'Ja existe um comando pendente para esta porta. Aguarde a confirmacao do armario.' };
          }
        } else {
          const next = withAudit(
            { ...current, commands: [command, ...(current.commands ?? [])] },
            'remote-open-requested',
            `Abertura remota solicitada para a porta ${door}.`,
            auditMeta
          );
          await writeState(next, requestLockerId);
        }
        return { status: 201, payload: { ok: true, command } };
      }
    );

    if (creationResult.error) {
      sendError(response, creationResult.status, creationResult.error);
    } else {
      sendJson(response, creationResult.status, creationResult.payload);
    }
    return;
  }

  const commandMatch = path.match(/^\/api\/admin\/commands\/([^/]+)$/);
  if (commandMatch && method === 'GET') {
    if (!hasAdminPermission(adminAuth, 'canOperateLocker')) {
      sendError(response, 403, 'Este papel nao pode acompanhar comandos remotos.');
      return;
    }
    const commandId = decodeURIComponent(commandMatch[1]);
    const command = (state.commands ?? []).find((item) => item.id === commandId);
    if (!command) {
      sendError(response, 404, 'Comando nao encontrado.');
      return;
    }
    sendJson(response, 200, { ok: true, command, runtime: getRuntimeSummary(state) });
    return;
  }

  if (method === 'POST' && path === '/api/device/events') {
    const body = await readBody(request);
    const lockerValidation = validateDeviceLocker(state, request, body);
    if (!lockerValidation.ok) {
      sendError(response, 403, lockerValidation.error);
      return;
    }
    const result = await applyDeviceEvents(state, body.events);
    await writeState(result.state, requestLockerId);
    sendJson(response, 200, {
      ok: true,
      acceptedIds: result.acceptedIds,
      failedEvents: result.failedEvents,
      notifications: result.notifications,
      processedAt: nowIso(),
    });
    void processNotificationOutboxFromDisk({ lockerId: requestLockerId });
    return;
  }

  if (method === 'POST' && path === '/api/device/deliveries/notify') {
    const body = await readBody(request);
    const lockerValidation = validateDeviceLocker(state, request, body);
    if (!lockerValidation.ok) {
      sendError(response, 403, lockerValidation.error);
      return;
    }
    const result = await notifyDeliveryStored(state, body);
    await writeState(result.state, requestLockerId);
    sendJson(response, 200, { ok: true, notification: result.notification });
    return;
  }

  const deliveryNotifyMatch = path.match(/^\/api\/admin\/deliveries\/([^/]+)\/notify$/);
  if (deliveryNotifyMatch && method === 'POST') {
    if (!hasAdminPermission(adminAuth, 'canOperateLocker')) {
      sendError(response, 403, 'Este papel nao pode reenviar notificacoes.');
      return;
    }
    const deliveryId = decodeURIComponent(deliveryNotifyMatch[1]);
    const delivery = (state.deliveries ?? []).find((item) => item.id === deliveryId);
    if (!delivery) {
      sendError(response, 404, 'Entrega nao encontrada.');
      return;
    }
    const result = await notifyDeliveryStored(state, { delivery }, { force: true });
    const next = withAudit(
      result.state,
      'delivery-notification-requested',
      `Reenvio de notificacao solicitado para a entrega ${delivery.id}.`,
      { deliveryId: delivery.id, actor: adminActor(adminAuth) }
    );
    await writeState(next, requestLockerId);
    sendJson(response, 200, {
      ok: true,
      notification: redactAdminNotification(result.notification, adminSession),
    });
    return;
  }

  if (method === 'POST' && path === '/api/device/status') {
    const body = await readBody(request);
    const lockerValidation = validateDeviceLocker(state, request, body);
    if (!lockerValidation.ok) {
      sendError(response, 403, lockerValidation.error);
      return;
    }
    const incomingDoors = Array.isArray(body.doors) ? body.doors : [];
    const nextDoors = incomingDoors.length > 0 ? incomingDoors.map((door) => {
      const channel = Number.parseInt(door.channel, 10);
      return {
        channel,
        label: cleanText(door.label) || `Porta ${channel}`,
        size: normalizeDoorSize(door.size, channel),
        status: cleanText(door.status) || 'unknown',
        occupancy: door.delivery ? 'busy' : 'free',
        delivery: door.delivery ?? null,
        lastSeenAt: nowIso(),
      };
    }) : state.doors;

    const next = {
      ...state,
      doors: nextDoors,
      deliveries: Array.isArray(body.deliveries) ? mergeDeviceDeliveries(state.deliveries, body.deliveries) : state.deliveries,
      device: {
        ...state.device,
        ...body.device,
        lockerId: cleanText(body.device?.lockerId) || cleanText(body.lockerId) || state.device?.lockerId || state.tenant?.lockerId || DEFAULT_LOCKER_ID,
        online: true,
        residentCount: Number.isInteger(Number.parseInt(body.device?.residentCount, 10))
          ? Number.parseInt(body.device.residentCount, 10)
          : state.device?.residentCount,
        residentsSyncedAt: cleanText(body.device?.residentsSyncedAt) || state.device?.residentsSyncedAt || '',
        remoteResidentsRevision: cleanText(body.device?.remoteResidentsRevision) || state.device?.remoteResidentsRevision || '',
        remoteBaseUrl: cleanText(body.device?.remoteBaseUrl ?? body.bridgeBaseUrl) || state.device?.remoteBaseUrl || '',
        lastSeenAt: nowIso(),
      },
    };
    await writeState(next, requestLockerId);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === 'GET' && path === '/api/device/snapshot') {
    const snapshot = await withLockerStateMutation(
      requestLockerId,
      state.tenant?.tenantId ?? DEFAULT_TENANT_ID,
      async () => {
        if (isPostgresStorage()) {
          const tenantId = normalizeTenantId(state.tenant?.tenantId ?? DEFAULT_TENANT_ID);
          const lockerId = normalizeLockerId(requestLockerId);
          const pool = await ensurePostgres();
          const leased = await leaseOperationalCommands(pool, {
            tenantId,
            lockerId,
            commandTtlMs: COMMAND_TTL_MS,
            leaseDurationMs: COMMAND_LEASE_MS,
            leaseIdFactory: () => createId('lease'),
          });
          let current = await readState(lockerId, tenantId);
          if (leased.expiredCount > 0 || leased.releasedLeaseCount > 0) {
            current = withCommandRefreshAudit(current, leased);
            await writeState(current, lockerId, tenantId);
          }
          return {
            ok: true,
            lockerId: current.tenant?.lockerId ?? DEFAULT_LOCKER_ID,
            residents: current.residents ?? [],
            residentsUpdatedAt: current.residentsUpdatedAt ?? current.updatedAt,
            commands: leased.leasedCommands,
            leaseDurationMs: COMMAND_LEASE_MS,
            serverTime: nowIso(),
          };
        }

        const current = await readFreshState(requestLockerId);
        const leasedCommands = [];
        const commands = (current.commands ?? []).map((command) => {
          if (command.status !== 'pending') return command;

          const leasedAt = nowIso();
          const leased = {
            ...command,
            status: 'leased',
            leaseId: createId('lease'),
            leasedAt,
            leaseExpiresAt: new Date(Date.now() + COMMAND_LEASE_MS).toISOString(),
            deliveryAttempt: Math.max(0, Number.parseInt(command.deliveryAttempt, 10) || 0) + 1,
            timeline: [
              ...(command.timeline ?? []),
              {
                status: 'leased',
                at: leasedAt,
                detail: 'Comando reservado para entrega; aguardando ACK antes da execucao.',
              },
            ],
          };
          leasedCommands.push(leased);
          return leased;
        });

        const next = leasedCommands.length > 0 ? { ...current, commands } : current;
        if (leasedCommands.length > 0) await writeState(next, requestLockerId);

        return {
          ok: true,
          lockerId: current.tenant?.lockerId ?? DEFAULT_LOCKER_ID,
          residents: current.residents ?? [],
          residentsUpdatedAt: current.residentsUpdatedAt ?? current.updatedAt,
          commands: leasedCommands,
          leaseDurationMs: COMMAND_LEASE_MS,
          serverTime: nowIso(),
        };
      }
    );
    sendJson(response, 200, snapshot);
    return;
  }

  const ackMatch = path.match(/^\/api\/device\/commands\/([^/]+)\/ack$/);
  if (ackMatch && method === 'POST') {
    const commandId = decodeURIComponent(ackMatch[1]);
    const body = await readBody(request);
    const leaseId = cleanText(body.leaseId);
    const executionId = cleanText(body.executionId);

    if (!leaseId || !executionId) {
      sendError(response, 400, 'leaseId e executionId sao obrigatorios para confirmar o comando.');
      return;
    }
    if (leaseId.length > 160 || executionId.length > 200) {
      sendError(response, 400, 'Identificadores do comando excedem o tamanho permitido.');
      return;
    }

    const ackResult = await withLockerStateMutation(
      requestLockerId,
      state.tenant?.tenantId ?? DEFAULT_TENANT_ID,
      async () => {
        if (isPostgresStorage()) {
          const tenantId = normalizeTenantId(state.tenant?.tenantId ?? DEFAULT_TENANT_ID);
          const lockerId = normalizeLockerId(requestLockerId);
          const pool = await ensurePostgres();
          const mutation = await mutateOperationalCommand(pool, {
            tenantId,
            lockerId,
            commandId,
            schemaVersion: SCHEMA_VERSION,
            commandTtlMs: COMMAND_TTL_MS,
            loadState: (client) => readNormalizedPostgresState(client, lockerId, tenantId),
            mutate: ({ command, state: lockedState, refresh }) =>
              applyCommandAcknowledgement(lockedState, command, { leaseId, executionId, refresh }),
          });
          if (!mutation.found) return { status: 404, error: 'Comando nao encontrado.' };
          if (mutation.conflict === 'execution-id') {
            return { status: 409, error: 'executionId ja pertence a outro comando deste armario.' };
          }
          return mutation;
        }

        const current = await readFreshState(requestLockerId);
        const command = (current.commands ?? []).find((item) => item.id === commandId);
        if (!command) {
          return { status: 404, error: 'Comando nao encontrado.' };
        }
        const outcome = applyCommandAcknowledgement(current, command, { leaseId, executionId });
        if (outcome.state) await writeState(outcome.state, requestLockerId);
        return outcome;
      }
    );

    if (ackResult.error) {
      sendError(response, ackResult.status, ackResult.error);
    } else {
      sendJson(response, ackResult.status, ackResult.payload);
    }
    return;
  }

  const completeMatch = path.match(/^\/api\/device\/commands\/([^/]+)\/complete$/);
  if (completeMatch && method === 'POST') {
    const commandId = decodeURIComponent(completeMatch[1]);
    const body = await readBody(request);
    const completionResult = await withLockerStateMutation(
      requestLockerId,
      state.tenant?.tenantId ?? DEFAULT_TENANT_ID,
      async () => {
        if (isPostgresStorage()) {
          const tenantId = normalizeTenantId(state.tenant?.tenantId ?? DEFAULT_TENANT_ID);
          const lockerId = normalizeLockerId(requestLockerId);
          const pool = await ensurePostgres();
          const mutation = await mutateOperationalCommand(pool, {
            tenantId,
            lockerId,
            commandId,
            schemaVersion: SCHEMA_VERSION,
            commandTtlMs: COMMAND_TTL_MS,
            loadState: (client) => readNormalizedPostgresState(client, lockerId, tenantId),
            mutate: ({ command, state: lockedState, refresh }) =>
              applyCommandCompletion(lockedState, command, body, { refresh }),
          });
          if (!mutation.found) return { status: 404, error: 'Comando nao encontrado.' };
          return mutation;
        }

        const current = await readFreshState(requestLockerId);
        const command = (current.commands ?? []).find((item) => item.id === commandId);
        if (!command) {
          return { status: 404, error: 'Comando nao encontrado.' };
        }
        const outcome = applyCommandCompletion(current, command, body);
        if (outcome.state) await writeState(outcome.state, requestLockerId);
        return outcome;
      }
    );

    if (completionResult.error) {
      sendError(response, completionResult.status, completionResult.error);
    } else {
      sendJson(response, completionResult.status, completionResult.payload);
    }
    return;
  }

  sendError(response, 404, 'Rota nao encontrada.');
}

const startupConfigErrors = getStartupConfigErrors();
if (startupConfigErrors.length > 0) {
  console.error('[PREDDITA] Configuracao insegura para producao:');
  for (const error of startupConfigErrors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

const server = createServer((request, response) => {
  applyCors(request, response);
  if ((request.url ?? '').startsWith('/api/')) {
    handleApi(request, response).catch((error) => sendError(response, 500, error.message));
    return;
  }
  serveStatic(request, response);
});

async function startServer() {
  if (isPostgresStorage()) {
    await ensurePostgres();
    await initializePostgresAdminAuth();
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[PREDDITA] Admin online em http://localhost:${PORT}`);
    void processNotificationOutboxFromDisk();
  });

  setInterval(() => {
    void processNotificationOutboxFromDisk();
  }, NOTIFICATION_OUTBOX_INTERVAL_MS).unref?.();
}

startServer().catch((error) => {
  console.error(`[PREDDITA] Falha ao iniciar servidor: ${error.message}`);
  process.exit(1);
});
