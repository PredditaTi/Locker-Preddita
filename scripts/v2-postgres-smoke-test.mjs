import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const requireAdmin = createRequire(join(ADMIN_DIR, 'package.json'));
const { Client } = requireAdmin('pg');
const SERVER_PATH = join(ADMIN_DIR, 'server.mjs');
const ADMIN_PASSWORD = 'v2-admin-postgres-password';
const ROTATED_ADMIN_PASSWORD = 'v2-admin-postgres-password-rotated';
const DEVICE_KEY = 'v2-device-postgres-key';
const MFA_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64');
const RUN_SUFFIX = Date.now().toString(36);
const LOCKER_ID = `locker-test-${RUN_SUFFIX}`;
const LEGACY_LOCKER_ID = `locker-legacy-${RUN_SUFFIX}`;
const ADMIN_USERNAME = `postgres-admin-${RUN_SUFFIX}`;
const PORT = 9898;
const SECONDARY_PORT = 9899;
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
  const { port = PORT, ...fetchOptions } = options;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...fetchOptions,
    headers: {
      'content-type': 'application/json',
      ...(fetchOptions.headers || {}),
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

async function requestDevice(path, options = {}) {
  const method = options.method || 'GET';
  const body = options.body || '';
  const headers = await createDeviceRequestAuthHeaders({
    method,
    path,
    lockerId: LOCKER_ID,
    deviceKey: DEVICE_KEY,
    body,
  });
  return request(path, { ...options, method, body: body || undefined, headers });
}

async function requestDeviceOk(path, options = {}) {
  const { response, payload } = await requestDevice(path, options);
  if (!response.ok || payload.ok === false) {
    throw new Error(`${path} failed: ${response.status} ${payload.error || response.statusText}`);
  }
  return payload;
}

async function waitForServer(port = PORT) {
  for (let index = 0; index < 60; index += 1) {
    try {
      const { response } = await request('/api/healthz', { port });
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
let secondaryServer = null;
let databaseClient = null;

function spawnServer({ adminUsersBootstrap = '', port = PORT } = {}) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ADMIN_DIR,
    env: {
      ...process.env,
      PORT: String(port),
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
  const normalizedDelivery = {
    id: `delivery-postgres-${RUN_SUFFIX}`,
    recipientId: 'unit-torre-a-203',
    recipientName: 'Apartamento 203',
    recipientEmail: 'postgres-smoke@example.com',
    unit: 'Torre A - 2 andar - Ap 203',
    building: 'Torre A',
    floor: '2',
    apartment: '203',
    door: 1,
    size: 'P',
    pin: '123456',
    token: `TOKEN-${RUN_SUFFIX}`,
    status: 'stored',
    createdAt: new Date().toISOString(),
    depositedAt: new Date().toISOString(),
  };
  const statusBody = JSON.stringify({
    lockerId: LOCKER_ID,
    device: { online: true, serialOpen: true, serialPath: '/dev/ttyS5', doorCount: 10 },
    doors: Array.from({ length: 10 }, (_, index) => ({
      channel: index + 1,
      status: 'closed',
      ...(index === 0 ? { delivery: normalizedDelivery } : {}),
    })),
    deliveries: [normalizedDelivery],
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

  secondaryServer = spawnServer({ port: SECONDARY_PORT });
  await waitForServer(SECONDARY_PORT);
  const commandRequest = {
    method: 'POST',
    headers: {
      cookie: adminHeaders.cookie,
      'x-csrf-token': adminHeaders.csrfToken,
    },
    body: JSON.stringify({ reason: 'Validar concorrencia transacional entre replicas.' }),
  };
  const concurrentCreations = await Promise.all([
    request('/api/admin/doors/2/open', commandRequest),
    request('/api/admin/doors/2/open', { ...commandRequest, port: SECONDARY_PORT }),
  ]);
  const successfulCreations = concurrentCreations.filter(({ response }) => response.status === 201);
  const rejectedCreations = concurrentCreations.filter(({ response }) => response.status === 409);
  if (successfulCreations.length !== 1 || rejectedCreations.length !== 1) {
    throw new Error(`Criacao concorrente deveria produzir um comando: ${concurrentCreations.map(({ response }) => response.status)}`);
  }
  const createdCommand = successfulCreations[0].payload;

  const concurrentSnapshots = await Promise.all([
    requestDeviceOk('/api/device/snapshot'),
    requestDeviceOk('/api/device/snapshot', { port: SECONDARY_PORT }),
  ]);
  const leasedCopies = concurrentSnapshots.flatMap((snapshot) =>
    snapshot.commands.filter((command) => command.id === createdCommand.command.id)
  );
  if (leasedCopies.length !== 1 || leasedCopies[0].status !== 'leased' || !leasedCopies[0].leaseId) {
    throw new Error('Duas replicas nao podem entregar o mesmo comando simultaneamente.');
  }
  const leasedCommand = leasedCopies[0];
  const executionId = `execution-postgres-${RUN_SUFFIX}`;
  const acknowledgementBody = JSON.stringify({ leaseId: leasedCommand.leaseId, executionId });
  const concurrentAcknowledgements = await Promise.all([
    requestDeviceOk(`/api/device/commands/${encodeURIComponent(createdCommand.command.id)}/ack`, {
      method: 'POST',
      body: acknowledgementBody,
    }),
    requestDeviceOk(`/api/device/commands/${encodeURIComponent(createdCommand.command.id)}/ack`, {
      method: 'POST',
      body: acknowledgementBody,
      port: SECONDARY_PORT,
    }),
  ]);
  if (
    concurrentAcknowledgements.filter((result) => result.duplicate === false).length !== 1
    || concurrentAcknowledgements.filter((result) => result.duplicate === true).length !== 1
  ) {
    throw new Error('ACK concorrente deveria registrar uma unica execucao e um replay idempotente.');
  }

  const completionBody = JSON.stringify({
    ok: true,
    confirmed: true,
    executionId,
    door: 2,
    releasedDoor: false,
    at: new Date().toISOString(),
  });
  const concurrentCompletions = await Promise.all([
    requestDeviceOk(`/api/device/commands/${encodeURIComponent(createdCommand.command.id)}/complete`, {
      method: 'POST',
      body: completionBody,
    }),
    requestDeviceOk(`/api/device/commands/${encodeURIComponent(createdCommand.command.id)}/complete`, {
      method: 'POST',
      body: completionBody,
      port: SECONDARY_PORT,
    }),
  ]);
  if (
    concurrentCompletions.filter((result) => result.duplicate === false).length !== 1
    || concurrentCompletions.filter((result) => result.duplicate === true).length !== 1
  ) {
    throw new Error('Conclusao concorrente deveria aplicar efeitos e auditoria uma unica vez.');
  }

  const state = await requestOk(`/api/admin/state?lockerId=${encodeURIComponent(LOCKER_ID)}`, {
    headers: adminHeaders,
  });
  if (state.state.tenant?.lockerId !== LOCKER_ID) {
    throw new Error('Estado Postgres deveria ser carregado pelo lockerId solicitado.');
  }
  if (state.state.runtime?.adminSessionStorage !== 'postgres') {
    throw new Error('Runtime deveria informar sessoes administrativas no Postgres.');
  }
  if (
    state.state.runtime?.operationalStorage !== 'normalized-postgres'
    || state.state.runtime?.operationalSchemaVersion !== 1
    || state.state.runtime?.commandMutationStorage !== 'row-postgres'
    || state.state.runtime?.commandSchemaVersion !== 1
    || state.state.runtime?.commandTransactionRetryAttempts !== 3
  ) {
    throw new Error('Runtime deveria informar dados operacionais e comandos transacionais no Postgres.');
  }
  if (
    !state.state.deliveries.some((delivery) => delivery.id === normalizedDelivery.id)
    || !state.state.commands.some((command) =>
      command.id === createdCommand.command.id && command.status === 'completed' && command.executionId === executionId
    )
  ) {
    throw new Error('API deveria hidratar entregas e comandos a partir das tabelas normalizadas.');
  }

  databaseClient = new Client({ connectionString: DATABASE_URL });
  await databaseClient.connect();
  const normalizedSnapshot = await databaseClient.query(
    `
      select operational_schema_version, state
      from preddita_locker_states
      where tenant_id = $1 and locker_id = $2
    `,
    ['tenant-postgres-smoke', LOCKER_ID]
  );
  const normalizedCoreState = normalizedSnapshot.rows[0]?.state || {};
  if (
    Number(normalizedSnapshot.rows[0]?.operational_schema_version) !== 1
    || ['residents', 'deliveries', 'commands', 'auditTrail'].some((key) => key in normalizedCoreState)
  ) {
    throw new Error('Snapshot central deveria guardar apenas o estado principal apos a normalizacao.');
  }
  const normalizedCounts = await databaseClient.query(
    `
      select
        (select count(*)::integer from preddita_residents where tenant_id = $1 and locker_id = $2) as residents,
        (select count(*)::integer from preddita_deliveries where tenant_id = $1 and locker_id = $2) as deliveries,
        (select count(*)::integer from preddita_commands where tenant_id = $1 and locker_id = $2) as commands,
        (select count(*)::integer from preddita_audit_events where tenant_id = $1 and locker_id = $2) as audit_events
    `,
    ['tenant-postgres-smoke', LOCKER_ID]
  );
  const counts = normalizedCounts.rows[0] || {};
  if (counts.residents < 1 || counts.deliveries !== 1 || counts.commands !== 1 || counts.audit_events < 2) {
    throw new Error(`Tabelas operacionais incompletas: ${JSON.stringify(counts)}`);
  }
  const commandRowResult = await databaseClient.query(
    `
      select status, lease_id, execution_id, delivery_attempt, revision, data,
        to_regclass('uq_preddita_commands_active_door') is not null as active_door_unique,
        to_regclass('uq_preddita_commands_execution') is not null as execution_unique,
        (
          select count(*)::integer
          from preddita_audit_events
          where tenant_id = $1 and locker_id = $2
            and kind = 'remote-open-completed'
            and meta->>'commandId' = $3
        ) as completion_audits
      from preddita_commands
      where tenant_id = $1 and locker_id = $2 and command_id = $3
    `,
    ['tenant-postgres-smoke', LOCKER_ID, createdCommand.command.id]
  );
  const commandRow = commandRowResult.rows[0] || {};
  if (
    commandRow.status !== 'completed'
    || commandRow.lease_id !== ''
    || commandRow.execution_id !== executionId
    || commandRow.delivery_attempt !== 1
    || Number(commandRow.revision) !== 3
    || commandRow.data?.status !== 'completed'
    || commandRow.active_door_unique !== true
    || commandRow.execution_unique !== true
    || commandRow.completion_audits !== 1
  ) {
    throw new Error(`Linha transacional do comando ficou inconsistente: ${JSON.stringify(commandRow)}`);
  }

  const legacyAt = new Date().toISOString();
  const legacyState = {
    schemaVersion: 7,
    tenant: {
      tenantId: 'tenant-postgres-smoke',
      lockerId: LEGACY_LOCKER_ID,
      siteName: 'Migracao Postgres',
      lockerName: 'Locker legado',
    },
    residents: [{
      id: 'resident-legacy',
      apartment: '901',
      building: 'Torre Legada',
      floor: '9',
      phone: '',
      email: '',
      createdAt: legacyAt,
      updatedAt: legacyAt,
    }],
    deliveries: [{
      id: 'delivery-legacy',
      recipientId: 'resident-legacy',
      unit: 'Torre Legada - 9 andar - Ap 901',
      door: 3,
      size: 'P',
      status: 'stored',
      createdAt: legacyAt,
      depositedAt: legacyAt,
    }],
    commands: [{
      id: 'command-legacy',
      type: 'openDoor',
      door: 4,
      status: 'pending',
      createdAt: legacyAt,
      timeline: [],
    }],
    auditTrail: [{
      id: 'audit-legacy',
      kind: 'legacy-state',
      message: 'Estado anterior a normalizacao.',
      at: legacyAt,
    }],
    updatedAt: legacyAt,
  };
  await databaseClient.query(
    `
      insert into preddita_locker_states (
        tenant_id, locker_id, schema_version, operational_schema_version, state, updated_at
      ) values ($1, $2, 7, 0, $3::jsonb, now())
    `,
    ['tenant-postgres-smoke', LEGACY_LOCKER_ID, JSON.stringify(legacyState)]
  );
  const migratedLegacyState = await requestOk(
    `/api/admin/state?lockerId=${encodeURIComponent(LEGACY_LOCKER_ID)}`,
    { headers: adminHeaders }
  );
  if (
    migratedLegacyState.state.residents[0]?.id !== 'resident-legacy'
    || migratedLegacyState.state.deliveries[0]?.id !== 'delivery-legacy'
    || migratedLegacyState.state.commands[0]?.id !== 'command-legacy'
    || migratedLegacyState.state.auditTrail[0]?.id !== 'audit-legacy'
  ) {
    throw new Error('Backfill deveria preservar todas as entidades do snapshot legado.');
  }
  const migratedLegacySnapshot = await databaseClient.query(
    `
      select operational_schema_version, state,
        (select count(*)::integer from preddita_residents where tenant_id = $1 and locker_id = $2) as residents,
        (select count(*)::integer from preddita_deliveries where tenant_id = $1 and locker_id = $2) as deliveries,
        (select count(*)::integer from preddita_commands where tenant_id = $1 and locker_id = $2) as commands,
        (select count(*)::integer from preddita_audit_events where tenant_id = $1 and locker_id = $2) as audit_events
      from preddita_locker_states
      where tenant_id = $1 and locker_id = $2
    `,
    ['tenant-postgres-smoke', LEGACY_LOCKER_ID]
  );
  const migratedRow = migratedLegacySnapshot.rows[0] || {};
  if (
    Number(migratedRow.operational_schema_version) !== 1
    || [migratedRow.residents, migratedRow.deliveries, migratedRow.commands, migratedRow.audit_events]
      .some((count) => count !== 1)
    || ['residents', 'deliveries', 'commands', 'auditTrail'].some((key) => key in (migratedRow.state || {}))
  ) {
    throw new Error(`Backfill relacional incompleto: ${JSON.stringify(migratedRow)}`);
  }

  await stopServer(secondaryServer);
  secondaryServer = null;
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
  await stopServer(secondaryServer);
  await stopServer(server);
  if (databaseClient) await databaseClient.end();
  rmSync(DATA_DIR, { recursive: true, force: true });
  if (serverLog && server?.exitCode && server.exitCode !== 0) {
    console.error(serverLog);
  }
}
