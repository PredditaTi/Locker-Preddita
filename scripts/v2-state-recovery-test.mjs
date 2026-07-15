import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashAdminPassword } from '../admin-online/adminAuth.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ADMIN_DIR = join(ROOT, 'admin-online');
const SERVER_PATH = join(ADMIN_DIR, 'server.mjs');
const ADMIN_PASSWORD = 'v2-recovery-admin-password';
const ADMIN_USERS = JSON.stringify([{
  username: 'recovery-admin',
  name: 'Recovery Admin',
  role: 'super_admin',
  passwordHash: hashAdminPassword(ADMIN_PASSWORD, { salt: 'recovery-admin-salt-001' }),
  lockerIds: ['*'],
}]);
const DEVICE_KEY = 'v2-recovery-device-key';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function startServer(dataDir, port) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ADMIN_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      PREDDITA_DATA_DIR: dataDir,
      PREDDITA_ADMIN_USERS: ADMIN_USERS,
      PREDDITA_DEVICE_KEY: DEVICE_KEY,
      PREDDITA_DEVICE_KEYS: JSON.stringify({ 'ks1062-aurora': DEVICE_KEY }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  child.stdout.on('data', (chunk) => {
    log += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    log += chunk.toString();
  });

  return { child, getLog: () => log };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([once(child, 'exit'), delay(1500)]);
}

async function request(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function waitForServer(port, child, getLog) {
  for (let index = 0; index < 40; index += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Servidor encerrou durante o teste de recuperacao.\n${getLog()}`);
    }
    try {
      const { response } = await request(port, '/api/healthz');
      if (response.ok) return;
    } catch (_error) {
    }
    await delay(150);
  }
  throw new Error(`Servidor nao iniciou durante o teste de recuperacao.\n${getLog()}`);
}

async function login(port) {
  const { response, payload } = await request(port, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'recovery-admin', password: ADMIN_PASSWORD }),
  });
  assert.equal(response.status, 200, payload.error || 'Login de recuperacao falhou.');
  return { cookie: String(response.headers.get('set-cookie') || '').split(';')[0] };
}

async function verifyBomStateIsPreserved() {
  const dataDir = mkdtempSync(join(tmpdir(), 'preddita-v2-bom-'));
  const statePath = join(dataDir, 'state.json');
  const port = 9901;
  const state = {
    schemaVersion: 6,
    tenant: {
      tenantId: 'residencial-aurora',
      lockerId: 'ks1062-aurora',
      siteName: 'Estado recuperado',
      lockerName: 'Locker recuperado',
    },
    residents: [
      {
        id: 'resident-recovered',
        apartment: '901',
        building: 'Torre Recuperada',
        floor: '9',
        phone: '',
        email: '',
      },
    ],
    deliveries: [
      {
        id: 'delivery-recovered',
        unit: 'Torre Recuperada - 9 andar - Ap 901',
        door: 3,
        size: 'P',
        pin: '123456',
        status: 'collected',
      },
    ],
    commands: [
      {
        id: 'cmd-legacy-sent',
        type: 'openDoor',
        door: 3,
        status: 'sent',
        createdAt: '2026-07-15T11:59:00.000Z',
        sentAt: '2026-07-15T12:00:00.000Z',
        timeline: [],
      },
    ],
    notificationOutbox: [],
    processedDeviceEvents: [],
    auditTrail: [
      {
        id: 'audit-recovered',
        kind: 'recovery-test',
        message: 'Estado de teste preservado.',
        at: '2026-07-15T12:00:00.000Z',
      },
    ],
    updatedAt: '2026-07-15T12:00:00.000Z',
  };

  writeFileSync(statePath, `\uFEFF${JSON.stringify(state, null, 2)}`);
  const originalHash = hashFile(statePath);
  const server = startServer(dataDir, port);

  try {
    await waitForServer(port, server.child, server.getLog);
    const adminHeaders = await login(port);
    const { response, payload } = await request(port, '/api/admin/state', {
      headers: adminHeaders,
    });

    assert.equal(response.status, 200, payload.error || 'Estado com BOM deveria ser aceito.');
    assert.equal(payload.state.residents.length, 1);
    assert.equal(payload.state.residents[0].id, 'resident-recovered');
    assert.equal(payload.state.deliveries.length, 1);
    assert.equal(payload.state.deliveries[0].id, 'delivery-recovered');
    assert.equal(payload.state.commands[0].status, 'failed');
    assert.equal(payload.state.commands[0].result.legacyDeliveryUnknown, true);
    assert.equal(hashFile(statePath), originalHash, 'Leitura nao deve reescrever o estado recuperado.');
  } finally {
    await stopServer(server.child);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function verifyInvalidStateFailsClosed() {
  const dataDir = mkdtempSync(join(tmpdir(), 'preddita-v2-invalid-state-'));
  const statePath = join(dataDir, 'state.json');
  const port = 9902;

  writeFileSync(statePath, '\uFEFF{"tenant":');
  const originalHash = hashFile(statePath);
  const server = startServer(dataDir, port);

  try {
    await waitForServer(port, server.child, server.getLog);
    const adminHeaders = await login(port);
    const { response, payload } = await request(port, '/api/admin/state', {
      headers: adminHeaders,
    });

    assert.equal(response.status, 500, 'Estado invalido deve bloquear a leitura da API.');
    assert.match(payload.error || '', /arquivo foi preservado/i);
    assert.equal(hashFile(statePath), originalHash, 'Estado invalido nunca deve ser sobrescrito.');
  } finally {
    await stopServer(server.child);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

await verifyBomStateIsPreserved();
await verifyInvalidStateFailsClosed();

console.log('PREDDITA_V2_STATE_RECOVERY_OK');
