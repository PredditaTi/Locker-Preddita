import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashAdminPassword } from '../admin-online/adminAuth.mjs';
import { generateTotp } from '../admin-online/adminMfa.mjs';
import { createDeviceRequestAuthHeaders } from '../web/src/deviceRequestAuth.js';

const DATABASE_URL = process.env.PREDDITA_TEST_DATABASE_URL || process.env.PREDDITA_DATABASE_URL || '';
if (!DATABASE_URL) {
  console.log('PREDDITA_V2_POSTGRES_SMOKE_SKIPPED');
  process.exit(0);
}

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ADMIN_DIR = join(ROOT, 'admin-online');
const SERVER_PATH = join(ADMIN_DIR, 'server.mjs');
const ADMIN_PASSWORD = 'v2-admin-postgres-password';
const ROTATED_ADMIN_PASSWORD = 'v2-admin-postgres-password-rotated';
const DEVICE_KEY = 'v2-device-postgres-key';
const MFA_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64');
const RUN_SUFFIX = Date.now().toString(36);
const LOCKER_ID = `locker-test-${RUN_SUFFIX}`;
const ADMIN_USERNAME = `postgres-admin-${RUN_SUFFIX}`;
const PORT = 9898;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'preddita-v2-pg-smoke-'));
const ADMIN_USERS = JSON.stringify([{
  username: ADMIN_USERNAME,
  name: 'Postgres Admin',
  role: 'super_admin',
  passwordHash: hashAdminPassword(ADMIN_PASSWORD, { salt: 'postgres-admin-salt-001' }),
  tenantId: 'tenant-postgres-smoke',
  lockerIds: ['*'],
}]);
const ROTATED_ADMIN_USERS = JSON.stringify([{
  username: ADMIN_USERNAME,
  name: 'Postgres Admin',
  role: 'super_admin',
  passwordHash: hashAdminPassword(ROTATED_ADMIN_PASSWORD, { salt: 'postgres-admin-salt-002' }),
  tenantId: 'tenant-postgres-smoke',
  lockerIds: ['*'],
}]);

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

async function startLogin(password = ADMIN_PASSWORD) {
  const { response, payload } = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: ADMIN_USERNAME, password }),
  });
  if (!response.ok) throw new Error(payload.error || 'Login Postgres falhou.');
  return { response, payload };
}

function sessionHeaders(response, payload) {
  return {
    cookie: String(response.headers.get('set-cookie') || '').split(';')[0],
    csrfToken: payload.session?.csrfToken || '',
    sessionId: payload.session?.id || '',
  };
}

async function verifyMfa(challengeToken, options = {}) {
  const { response, payload } = await request('/api/auth/mfa/verify', {
    method: 'POST',
    body: JSON.stringify({
      challengeToken,
      ...(options.recoveryCode
        ? { recoveryCode: options.recoveryCode }
        : { code: options.code }),
    }),
  });
  return { response, payload };
}

async function waitForNextTotpStep(lastCounter) {
  let counter = Math.floor(Date.now() / 30_000);
  while (counter <= lastCounter) {
    await delay(250);
    counter = Math.floor(Date.now() / 30_000);
  }
  return counter;
}

function createKnownInvalidTotp(secret) {
  const currentCounter = Math.floor(Date.now() / 30_000);
  const nearbyCodes = new Set(
    Array.from({ length: 5 }, (_, index) => generateTotp(secret, { counter: currentCounter + index - 2 }))
  );
  return ['000000', '111111', '222222', '333333', '444444', '555555']
    .find((candidate) => !nearbyCodes.has(candidate));
}

let serverLog = '';
let server = null;

function spawnServer({ adminUsersBootstrap = '' } = {}) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ADMIN_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      PREDDITA_STORAGE: 'postgres',
      PREDDITA_DATABASE_URL: DATABASE_URL,
      PREDDITA_DATA_DIR: DATA_DIR,
      PREDDITA_TENANT_ID: 'tenant-postgres-smoke',
      PREDDITA_LOCKER_ID: LOCKER_ID,
      PREDDITA_ADMIN_USERS: adminUsersBootstrap,
      PREDDITA_MFA_ENCRYPTION_KEY: MFA_ENCRYPTION_KEY,
      PREDDITA_DEVICE_KEY: DEVICE_KEY,
      PREDDITA_DEVICE_KEYS: JSON.stringify({ [LOCKER_ID]: DEVICE_KEY }),
      PREDDITA_DEVICE_AUTH_MODE: 'hmac',
      PREDDITA_COMMAND_TTL_MS: '30000',
      PREDDITA_DEVICE_STALE_MS: '30000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    serverLog += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    serverLog += chunk.toString();
  });
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(2000),
  ]);
}

try {
  server = spawnServer({ adminUsersBootstrap: ADMIN_USERS });
  await waitForServer();

  const enrollmentLogin = await startLogin();
  if (!enrollmentLogin.payload.mfa?.enrollment || enrollmentLogin.payload.session) {
    throw new Error('Primeiro login privilegiado deveria exigir cadastro MFA sem criar sessao.');
  }
  const mfaSecret = enrollmentLogin.payload.mfa.secret;
  const enrollmentCounter = Math.floor(Date.now() / 30_000);
  const enrollmentVerification = await verifyMfa(
    enrollmentLogin.payload.mfa.challengeToken,
    { code: generateTotp(mfaSecret, { counter: enrollmentCounter }) }
  );
  if (!enrollmentVerification.response.ok) {
    throw new Error(enrollmentVerification.payload.error || 'Cadastro MFA falhou.');
  }
  const recoveryCodes = enrollmentVerification.payload.mfa?.recoveryCodes || [];
  if (recoveryCodes.length < 6) {
    throw new Error('Cadastro MFA deveria emitir codigos de recuperacao de uso unico.');
  }
  const adminHeaders = sessionHeaders(enrollmentVerification.response, enrollmentVerification.payload);
  const statusBody = JSON.stringify({
    lockerId: LOCKER_ID,
    device: { online: true, serialOpen: true, serialPath: '/dev/ttyS5', doorCount: 10 },
    doors: Array.from({ length: 10 }, (_, index) => ({ channel: index + 1, status: 'closed' })),
  });
  const deviceHeaders = await createDeviceRequestAuthHeaders({
    method: 'POST',
    path: '/api/device/status',
    lockerId: LOCKER_ID,
    deviceKey: DEVICE_KEY,
    body: statusBody,
  });

  await requestOk('/api/device/status', {
    method: 'POST',
    headers: deviceHeaders,
    body: statusBody,
  });

  const state = await requestOk(`/api/admin/state?lockerId=${encodeURIComponent(LOCKER_ID)}`, {
    headers: adminHeaders,
  });
  if (state.state.tenant?.lockerId !== LOCKER_ID) {
    throw new Error('Estado Postgres deveria ser carregado pelo lockerId solicitado.');
  }
  if (state.state.runtime?.adminSessionStorage !== 'postgres') {
    throw new Error('Runtime deveria informar sessoes administrativas no Postgres.');
  }

  await stopServer(server);
  server = spawnServer();
  await waitForServer();

  const restoredSession = await requestOk('/api/auth/session', {
    headers: { cookie: adminHeaders.cookie },
  });
  if (restoredSession.session?.id !== adminHeaders.sessionId) {
    throw new Error('Sessao administrativa deveria sobreviver ao restart do servidor.');
  }

  await requestOk('/api/auth/logout', {
    method: 'POST',
    headers: {
      cookie: adminHeaders.cookie,
      'x-csrf-token': adminHeaders.csrfToken,
    },
    body: '{}',
  });

  await stopServer(server);
  server = spawnServer();
  await waitForServer();
  const revokedSession = await request('/api/auth/session', {
    headers: { cookie: adminHeaders.cookie },
  });
  if (revokedSession.response.status !== 401) {
    throw new Error('Sessao revogada nao pode voltar depois de novo restart.');
  }

  const lockedChallengeLogin = await startLogin();
  const invalidTotp = createKnownInvalidTotp(mfaSecret);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rejectedAttempt = await verifyMfa(
      lockedChallengeLogin.payload.mfa.challengeToken,
      { code: invalidTotp }
    );
    if (rejectedAttempt.response.status !== 401) {
      throw new Error('Tentativa TOTP invalida deveria ser recusada.');
    }
  }
  const exhaustedChallenge = await verifyMfa(
    lockedChallengeLogin.payload.mfa.challengeToken,
    { code: invalidTotp }
  );
  if (exhaustedChallenge.response.status !== 401 || !/Desafio MFA/.test(exhaustedChallenge.payload.error || '')) {
    throw new Error('Desafio MFA deveria ser consumido depois de cinco tentativas invalidas.');
  }

  const enrolledLogin = await startLogin();
  if (enrolledLogin.payload.mfa?.enrollment !== false) {
    throw new Error('Conta cadastrada deveria pedir apenas o codigo MFA.');
  }
  const freshCounter = await waitForNextTotpStep(enrollmentCounter);
  const currentTotp = generateTotp(mfaSecret, { counter: freshCounter });
  const totpVerification = await verifyMfa(
    enrolledLogin.payload.mfa.challengeToken,
    { code: currentTotp }
  );
  if (!totpVerification.response.ok) {
    throw new Error(totpVerification.payload.error || 'Verificacao TOTP falhou.');
  }
  const sessionBeforePasswordRotation = sessionHeaders(totpVerification.response, totpVerification.payload);

  const replayLogin = await startLogin();
  const replayVerification = await verifyMfa(
    replayLogin.payload.mfa.challengeToken,
    { code: currentTotp }
  );
  if (replayVerification.response.status !== 401) {
    throw new Error('O mesmo TOTP nao pode ser aceito duas vezes.');
  }

  const recoveryLogin = await startLogin();
  const recoveryVerification = await verifyMfa(
    recoveryLogin.payload.mfa.challengeToken,
    { recoveryCode: recoveryCodes[0] }
  );
  if (!recoveryVerification.response.ok) {
    throw new Error(recoveryVerification.payload.error || 'Codigo de recuperacao valido foi recusado.');
  }
  const recoveryReplayLogin = await startLogin();
  const recoveryReplay = await verifyMfa(
    recoveryReplayLogin.payload.mfa.challengeToken,
    { recoveryCode: recoveryCodes[0] }
  );
  if (recoveryReplay.response.status !== 401) {
    throw new Error('Codigo de recuperacao utilizado nao pode ser aceito novamente.');
  }

  await stopServer(server);
  server = spawnServer({ adminUsersBootstrap: ROTATED_ADMIN_USERS });
  await waitForServer();
  const sessionAfterPasswordRotation = await request('/api/auth/session', {
    headers: { cookie: sessionBeforePasswordRotation.cookie },
  });
  if (sessionAfterPasswordRotation.response.status !== 401) {
    throw new Error('Rotacao de senha deveria revogar sessoes administrativas anteriores.');
  }
  const rotatedLogin = await startLogin(ROTATED_ADMIN_PASSWORD);
  const rotatedVerification = await verifyMfa(
    rotatedLogin.payload.mfa.challengeToken,
    { recoveryCode: recoveryCodes[1] }
  );
  if (!rotatedVerification.response.ok) {
    throw new Error(rotatedVerification.payload.error || 'Login com senha rotacionada e MFA falhou.');
  }

  console.log('PREDDITA_V2_POSTGRES_SMOKE_OK');
} finally {
  await stopServer(server);
  rmSync(DATA_DIR, { recursive: true, force: true });
  if (serverLog && server?.exitCode && server.exitCode !== 0) {
    console.error(serverLog);
  }
}
