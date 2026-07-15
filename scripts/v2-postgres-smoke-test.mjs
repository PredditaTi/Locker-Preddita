import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATABASE_URL = process.env.PREDDITA_TEST_DATABASE_URL || process.env.PREDDITA_DATABASE_URL || '';
if (!DATABASE_URL) {
  console.log('PREDDITA_V2_POSTGRES_SMOKE_SKIPPED');
  process.exit(0);
}

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ADMIN_DIR = join(ROOT, 'admin-online');
const SERVER_PATH = join(ADMIN_DIR, 'server.mjs');
const ADMIN_TOKEN = 'v2-admin-postgres-token';
const SUPER_ADMIN_TOKEN = 'v2-super-postgres-token';
const DEVICE_KEY = 'v2-device-postgres-key';
const LOCKER_ID = `locker-test-${Date.now().toString(36)}`;
const PORT = 9898;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'preddita-v2-pg-smoke-'));

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function requestOk(path, options = {}) {
  const { response, payload } = await request(path, options);
  if (!response.ok || payload.ok === false) {
    throw new Error(`${path} failed: ${response.status} ${payload.error || response.statusText}`);
  }
  return payload;
}

async function waitForServer() {
  for (let index = 0; index < 60; index += 1) {
    try {
      const { response } = await request('/api/healthz');
      if (response.ok) return;
    } catch (_error) {
    }
    await delay(250);
  }
  throw new Error('Servidor Postgres nao iniciou dentro do tempo esperado.');
}

const server = spawn(process.execPath, [SERVER_PATH], {
  cwd: ADMIN_DIR,
  env: {
    ...process.env,
    PORT: String(PORT),
    PREDDITA_STORAGE: 'postgres',
    PREDDITA_DATABASE_URL: DATABASE_URL,
    PREDDITA_DATA_DIR: DATA_DIR,
    PREDDITA_TENANT_ID: 'tenant-postgres-smoke',
    PREDDITA_LOCKER_ID: LOCKER_ID,
    PREDDITA_ADMIN_TOKEN: ADMIN_TOKEN,
    PREDDITA_SUPER_ADMIN_TOKEN: SUPER_ADMIN_TOKEN,
    PREDDITA_DEVICE_KEY: DEVICE_KEY,
    PREDDITA_DEVICE_KEYS: JSON.stringify({ [LOCKER_ID]: DEVICE_KEY }),
    PREDDITA_COMMAND_TTL_MS: '30000',
    PREDDITA_DEVICE_STALE_MS: '30000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (chunk) => {
  serverLog += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  serverLog += chunk.toString();
});

try {
  await waitForServer();

  const adminHeaders = { 'x-admin-token': ADMIN_TOKEN };
  const deviceHeaders = { 'x-device-key': DEVICE_KEY, 'x-locker-id': LOCKER_ID };

  await requestOk('/api/device/status', {
    method: 'POST',
    headers: deviceHeaders,
    body: JSON.stringify({
      lockerId: LOCKER_ID,
      device: { online: true, serialOpen: true, serialPath: '/dev/ttyS5', doorCount: 10 },
      doors: Array.from({ length: 10 }, (_, index) => ({ channel: index + 1, status: 'closed' })),
    }),
  });

  const state = await requestOk(`/api/admin/state?lockerId=${encodeURIComponent(LOCKER_ID)}`, {
    headers: adminHeaders,
  });
  if (state.state.tenant?.lockerId !== LOCKER_ID) {
    throw new Error('Estado Postgres deveria ser carregado pelo lockerId solicitado.');
  }

  console.log('PREDDITA_V2_POSTGRES_SMOKE_OK');
} finally {
  server.kill();
  await delay(300);
  rmSync(DATA_DIR, { recursive: true, force: true });
  if (server.exitCode && server.exitCode !== 0) {
    console.error(serverLog);
  }
}
