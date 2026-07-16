import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashAdminPassword } from '../admin-online/adminAuth.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ADMIN_DIR = join(ROOT, 'admin-online');
const SERVER_PATH = join(ADMIN_DIR, 'server.mjs');
const PORT = 9901;
const LOCAL_BASE_URL = `http://127.0.0.1:${PORT}`;
const PUBLIC_BASE_URL = 'https://contract.preddita.test';
const LOCKER_ID = 'ks1062-aurora';
const DEVICE_KEY = 'v2-api-contract-device-key';
const ADMIN_PASSWORD = 'v2-api-contract-admin-password';
const DATA_DIR = mkdtempSync(join(tmpdir(), 'preddita-api-contract-'));
const ADMIN_USERS = JSON.stringify([
  {
    username: 'sindico-contract',
    name: 'Sindico Contract',
    role: 'sindico',
    passwordHash: hashAdminPassword(ADMIN_PASSWORD, { salt: 'api-contract-sindico-salt' }),
    lockerIds: [LOCKER_ID],
  },
]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertRecord(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function assertString(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
}

function assertIsoDate(value, label) {
  assertString(value, label);
  assert.ok(Number.isFinite(Date.parse(value)), `${label} must be an ISO date`);
}

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

const server = spawn(process.execPath, [SERVER_PATH], {
  cwd: ADMIN_DIR,
  env: {
    ...process.env,
    PORT: String(PORT),
    PREDDITA_DATA_DIR: DATA_DIR,
    PREDDITA_STORAGE: 'json',
    PREDDITA_ADMIN_USERS: ADMIN_USERS,
    PREDDITA_DEVICE_KEYS: JSON.stringify({ [LOCKER_ID]: DEVICE_KEY }),
    PREDDITA_DEVICE_AUTH_MODE: 'hmac',
    PREDDITA_DEVICE_SIGNATURE_TTL_MS: '60000',
    PREDDITA_COMMAND_TTL_MS: '30000',
    PREDDITA_COMMAND_LEASE_MS: '3000',
    PREDDITA_COMMAND_EXECUTION_LEASE_MS: '10000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

const nativeFetch = globalThis.fetch.bind(globalThis);
const previousWindow = globalThis.window;
const previousFetch = globalThis.fetch;

async function localRequest(path, options = {}) {
  const response = await nativeFetch(`${LOCAL_BASE_URL}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function localRequestOk(path, options = {}) {
  const result = await localRequest(path, options);
  assert.equal(result.response.ok, true, `${path} returned ${result.response.status}: ${result.payload.error || ''}`);
  assert.notEqual(result.payload.ok, false, `${path} returned an application error`);
  return result;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const { response } = await localRequest('/api/healthz');
      if (response.ok) return;
    } catch (_error) {
    }
    await delay(250);
  }
  throw new Error(`API contract server did not start.\n${serverOutput}`);
}

function signNativeDeviceRequest(method, path, timestamp, nonce, contentSha256) {
  const canonical = [
    'PREDDITA-HMAC-V1',
    String(method || 'GET').toUpperCase(),
    String(path),
    LOCKER_ID,
    String(timestamp),
    String(nonce),
    String(contentSha256).toLowerCase(),
  ].join('\n');
  return `v1=${createHmac('sha256', DEVICE_KEY).update(canonical).digest('hex')}`;
}

try {
  await waitForServer();

  const health = await localRequestOk('/api/healthz');
  assert.equal(health.payload.ok, true);
  assertString(health.payload.appVersion, 'health.appVersion');
  assert.equal(Number.isInteger(health.payload.schemaVersion), true);
  assertIsoDate(health.payload.at, 'health.at');

  const login = await localRequestOk('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'sindico-contract', password: ADMIN_PASSWORD }),
  });
  assertRecord(login.payload.session, 'login.session');
  assert.equal(login.payload.session.username, 'sindico-contract');
  assert.equal(login.payload.session.role, 'sindico');
  assertString(login.payload.session.csrfToken, 'login.session.csrfToken');
  assert.ok(login.payload.session.csrfToken.length >= 32, 'CSRF token is too short');
  const setCookie = String(login.response.headers.get('set-cookie') || '');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const adminHeaders = {
    cookie: setCookie.split(';')[0],
    'x-csrf-token': login.payload.session.csrfToken,
  };

  const createdResident = await localRequestOk('/api/admin/residents', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      apartment: '901',
      floor: '9',
      building: 'Torre Contract',
      phone: '47999990000',
      email: 'contract@example.com',
    }),
  });
  assert.equal(createdResident.response.status, 201);
  assertRecord(createdResident.payload.resident, 'resident create response');
  assertString(createdResident.payload.resident.id, 'resident.id');
  assert.equal(createdResident.payload.resident.apartment, '901');

  const memoryStorage = createMemoryStorage();
  globalThis.window = {
    localStorage: memoryStorage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    PredditaDeviceAuth: {
      getConfig() {
        return JSON.stringify({
          provisioned: true,
          baseUrl: PUBLIC_BASE_URL,
          lockerId: LOCKER_ID,
          signer: 'contract-native-hmac',
          provisionedAt: Date.now(),
        });
      },
      signRequest: signNativeDeviceRequest,
      getLastError() {
        return '';
      },
    },
  };
  globalThis.fetch = (input, options) => {
    const requestedUrl = String(input);
    const localUrl = requestedUrl.startsWith(PUBLIC_BASE_URL)
      ? `${LOCAL_BASE_URL}${requestedUrl.slice(PUBLIC_BASE_URL.length)}`
      : requestedUrl;
    return nativeFetch(localUrl, options);
  };

  const remoteBridgeUrl = new URL('../web/src/remoteBridge.js', import.meta.url);
  remoteBridgeUrl.searchParams.set('contract', String(Date.now()));
  const RemoteBridge = await import(remoteBridgeUrl.href);

  const statusPublished = await RemoteBridge.publishRemoteStatus({
    device: {
      online: true,
      serialOpen: true,
      bridgeVersion: 'CONTRACT-BRIDGE',
      board: 1,
      doorCount: 4,
    },
    doors: Array.from({ length: 4 }, (_, index) => ({
      channel: index + 1,
      label: `Porta ${index + 1}`,
      size: index === 0 ? 'G' : 'P',
      status: 'closed',
    })),
    deliveries: [],
  });
  assert.equal(statusPublished, true, 'remoteBridge.publishRemoteStatus contract failed');

  const initialSnapshot = await RemoteBridge.fetchRemoteSnapshot();
  assertRecord(initialSnapshot, 'device snapshot');
  assert.equal(initialSnapshot.ok, true);
  assert.equal(initialSnapshot.lockerId, LOCKER_ID);
  assert.ok(Array.isArray(initialSnapshot.residents));
  assert.ok(Array.isArray(initialSnapshot.commands));
  assert.equal(typeof initialSnapshot.leaseDurationMs, 'number');
  assertIsoDate(initialSnapshot.serverTime, 'snapshot.serverTime');
  const contractResident = initialSnapshot.residents.find((resident) => resident.id === createdResident.payload.resident.id);
  assertRecord(contractResident, 'snapshot resident');
  assert.equal(contractResident.email, 'contract@example.com');

  const mappedResident = RemoteBridge.mapRemoteResidentToRecipient(contractResident);
  assert.equal(mappedResident.name, 'Apartamento 901');
  assert.equal(mappedResident.unit, 'Torre Contract - 9 andar - Ap 901');

  const commandCreated = await localRequestOk('/api/admin/doors/2/open', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ reason: 'API consumer contract' }),
  });
  assert.equal(commandCreated.response.status, 201);
  assertRecord(commandCreated.payload.command, 'command create response');
  assert.equal(commandCreated.payload.command.type, 'openDoor');
  assert.equal(commandCreated.payload.command.status, 'pending');

  const leasedSnapshot = await RemoteBridge.fetchRemoteSnapshot();
  const leasedCommand = leasedSnapshot.commands.find(
    (command) => command.id === commandCreated.payload.command.id
  );
  assertRecord(leasedCommand, 'leased command');
  assert.equal(leasedCommand.status, 'leased');
  assertString(leasedCommand.leaseId, 'leased command leaseId');
  assertIsoDate(leasedCommand.leaseExpiresAt, 'leased command leaseExpiresAt');

  const executionId = 'api-contract-execution-001';
  const acknowledged = await RemoteBridge.acknowledgeRemoteCommand(
    leasedCommand.id,
    leasedCommand.leaseId,
    executionId
  );
  assertRecord(acknowledged, 'command acknowledgement');
  assert.equal(acknowledged.ok, true);
  assert.equal(acknowledged.command.status, 'executing');
  assert.equal(acknowledged.command.executionId, executionId);
  assert.equal(acknowledged.duplicate, false);

  const completed = await RemoteBridge.completeRemoteCommand(leasedCommand.id, {
    ok: true,
    confirmed: true,
    reason: 'closed',
    executionId,
    door: leasedCommand.door,
    releasedDoor: false,
    pendingPhysicalClose: false,
    at: new Date().toISOString(),
  });
  assertRecord(completed, 'command completion');
  assert.equal(completed.ok, true);
  assert.equal(completed.command.status, 'completed');
  assert.equal(completed.command.result.confirmed, true);
  assert.equal(completed.duplicate, false);

  const depositedAt = new Date().toISOString();
  const delivery = {
    id: 'delivery-api-contract-001',
    recipientId: contractResident.id,
    recipientName: 'Apartamento 901',
    recipientEmail: contractResident.email,
    unit: mappedResident.unit,
    building: contractResident.building,
    size: 'P',
    door: 3,
    doorSize: 'P',
    pin: '731904',
    token: 'API-CONTRACT-TOKEN',
    qrPayload: 'preddita://collect?id=delivery-api-contract-001&token=API-CONTRACT-TOKEN',
    status: 'stored',
    createdAt: depositedAt,
    depositedAt,
  };
  const syncedEvents = await RemoteBridge.publishRemoteEvents([
    {
      id: 'event-api-contract-stored-001',
      type: 'delivery-stored',
      occurredAt: depositedAt,
      payload: { delivery, sendEmail: false },
    },
  ]);
  assertRecord(syncedEvents, 'device event sync');
  assert.equal(syncedEvents.ok, true);
  assert.ok(syncedEvents.acceptedIds.includes('event-api-contract-stored-001'));
  assert.ok(Array.isArray(syncedEvents.failedEvents));
  assert.ok(Array.isArray(syncedEvents.notifications));

  const mqttTicket = await RemoteBridge.fetchMqttTicket();
  assertRecord(mqttTicket, 'MQTT fallback ticket');
  assert.equal(mqttTicket.ok, true);
  assert.equal(mqttTicket.enabled, false);
  assert.equal(mqttTicket.mode, 'disabled');
  assert.equal(mqttTicket.fallbackPollMs, 6000);
  assert.equal('url' in mqttTicket, false, 'disabled MQTT ticket must not expose a signed URL');

  const commandState = await localRequestOk(
    `/api/admin/commands/${encodeURIComponent(leasedCommand.id)}`,
    { headers: adminHeaders }
  );
  assert.equal(commandState.payload.command.status, 'completed');
  assertRecord(commandState.payload.runtime, 'command runtime');

  const loggedOut = await localRequestOk('/api/auth/logout', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(loggedOut.payload.ok, true);

  console.log('PASS API consumer contract: admin session, residents, device snapshot, events and command lifecycle');
} finally {
  globalThis.fetch = previousFetch;
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  server.kill();
  await delay(300);
  rmSync(DATA_DIR, { recursive: true, force: true });
  if (server.exitCode && server.exitCode !== 0) {
    console.error(serverOutput);
  }
}
