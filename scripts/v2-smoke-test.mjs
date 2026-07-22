import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeviceRequestAuthHeaders } from '../web/src/deviceRequestAuth.js';
import { hashAdminPassword } from '../admin-online/adminAuth.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ADMIN_DIR = join(ROOT, 'admin-online');
const SERVER_PATH = join(ADMIN_DIR, 'server.mjs');
const SINDICO_PASSWORD = 'v2-sindico-password';
const OPERATOR_PASSWORD = 'v2-operator-password';
const SUPER_ADMIN_PASSWORD = 'v2-super-admin-password';
const DEVICE_KEY = 'v2-device-test-key';
const EXPECTED_ADMIN_VERSION = '2.0.33-lab';
const PORT = 9897;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'preddita-v2-smoke-'));
const ADMIN_USERS = JSON.stringify([
  {
    username: 'sindico-smoke',
    name: 'Sindico Smoke',
    role: 'sindico',
    passwordHash: hashAdminPassword(SINDICO_PASSWORD, { salt: 'smoke-sindico-salt-001' }),
    lockerIds: ['ks1062-aurora'],
  },
  {
    username: 'operador-smoke',
    name: 'Operador Smoke',
    role: 'operador',
    passwordHash: hashAdminPassword(OPERATOR_PASSWORD, { salt: 'smoke-operador-salt-001' }),
    lockerIds: ['ks1062-aurora'],
  },
  {
    username: 'preddita-smoke',
    name: 'Admin PREDDITA Smoke',
    role: 'super_admin',
    passwordHash: hashAdminPassword(SUPER_ADMIN_PASSWORD, { salt: 'smoke-super-admin-salt-01' }),
    lockerIds: ['*'],
  },
]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const { deviceAuth = false, deviceAuthOptions = {}, ...fetchOptions } = options;
  const authHeaders = deviceAuth
    ? await createDeviceRequestAuthHeaders({
        method: fetchOptions.method || 'GET',
        path,
        lockerId: deviceAuthOptions.lockerId || 'ks1062-aurora',
        deviceKey: deviceAuthOptions.deviceKey || DEVICE_KEY,
        body: deviceAuthOptions.body ?? fetchOptions.body ?? '',
        timestamp: deviceAuthOptions.timestamp,
        nonce: deviceAuthOptions.nonce,
      })
    : {};
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...fetchOptions,
    headers: {
      'content-type': 'application/json',
      ...(fetchOptions.headers || {}),
      ...authHeaders,
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

async function login(username, password) {
  const { response, payload } = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok || !payload.session?.csrfToken) {
    throw new Error(`Login de ${username} falhou: ${response.status} ${payload.error || ''}`);
  }
  const setCookie = String(response.headers.get('set-cookie') || '');
  if (!setCookie.includes('HttpOnly') || !setCookie.includes('SameSite=Strict')) {
    throw new Error(`Login de ${username} retornou cookie sem protecoes obrigatorias.`);
  }
  const cookie = setCookie.split(';')[0];
  if (!cookie) throw new Error(`Login de ${username} nao retornou cookie de sessao.`);
  return { cookie, 'x-csrf-token': payload.session.csrfToken };
}

async function waitForServer() {
  for (let index = 0; index < 40; index += 1) {
    try {
      const { response } = await request('/api/healthz');
      if (response.ok) return;
    } catch (_error) {
    }
    await delay(250);
  }
  throw new Error('Servidor v2 nao iniciou dentro do tempo esperado.');
}

async function assertProductionRejectsLegacyAuth() {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ADMIN_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT + 1),
      PREDDITA_DATA_DIR: DATA_DIR,
      PREDDITA_STORAGE: 'json',
      PREDDITA_ALLOWED_ORIGINS: 'https://locker.example.com',
      PREDDITA_ADMIN_USERS: ADMIN_USERS,
      PREDDITA_DEVICE_KEY: DEVICE_KEY,
      PREDDITA_DEVICE_KEYS: JSON.stringify({ 'ks1062-aurora': DEVICE_KEY }),
      PREDDITA_DEVICE_AUTH_MODE: 'legacy',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Servidor inseguro nao encerrou no startup.'));
    }, 3000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  if (exitCode === 0 || !output.includes('PREDDITA_DEVICE_AUTH_MODE deve ser hmac em producao.')) {
    throw new Error('Producao deveria falhar no startup quando a autenticacao do device nao usa HMAC.');
  }
}

async function assertProductionRejectsMissingAdminUsers() {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ADMIN_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT + 2),
      PREDDITA_DATA_DIR: DATA_DIR,
      PREDDITA_STORAGE: 'json',
      PREDDITA_ALLOWED_ORIGINS: 'https://locker.example.com',
      PREDDITA_ADMIN_USERS: '',
      PREDDITA_DEVICE_KEY: DEVICE_KEY,
      PREDDITA_DEVICE_KEYS: JSON.stringify({ 'ks1062-aurora': DEVICE_KEY }),
      PREDDITA_DEVICE_AUTH_MODE: 'hmac',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Servidor sem usuarios administrativos nao encerrou no startup.'));
    }, 3000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  if (exitCode === 0 || !output.includes('PREDDITA_ADMIN_USERS deve definir usuarios')) {
    throw new Error('Producao deveria falhar no startup sem usuarios administrativos.');
  }
}

async function assertProductionRejectsMissingMfaKey() {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ADMIN_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT + 3),
      PREDDITA_DATA_DIR: DATA_DIR,
      PREDDITA_STORAGE: 'postgres',
      PREDDITA_DATABASE_URL: 'postgresql://localhost/preddita-startup-check',
      PREDDITA_ALLOWED_ORIGINS: 'https://locker.example.com',
      PREDDITA_ADMIN_USERS: ADMIN_USERS,
      PREDDITA_MFA_ENCRYPTION_KEY: '',
      PREDDITA_DEVICE_KEY: DEVICE_KEY,
      PREDDITA_DEVICE_KEYS: JSON.stringify({ 'ks1062-aurora': DEVICE_KEY }),
      PREDDITA_DEVICE_AUTH_MODE: 'hmac',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Servidor sem chave MFA nao encerrou no startup.'));
    }, 3000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  if (exitCode === 0 || !output.includes('PREDDITA_MFA_ENCRYPTION_KEY deve ser definido em producao')) {
    throw new Error('Producao deveria falhar no startup sem a chave de criptografia MFA.');
  }
}

const server = spawn(process.execPath, [SERVER_PATH], {
  cwd: ADMIN_DIR,
  env: {
    ...process.env,
    PORT: String(PORT),
    PREDDITA_DATA_DIR: DATA_DIR,
    PREDDITA_ADMIN_USERS: ADMIN_USERS,
    PREDDITA_DEVICE_KEY: DEVICE_KEY,
    PREDDITA_DEVICE_KEYS: JSON.stringify({ 'ks1062-aurora': DEVICE_KEY }),
    PREDDITA_DEVICE_AUTH_MODE: 'hmac',
    PREDDITA_DEVICE_SIGNATURE_TTL_MS: '60000',
    PREDDITA_COMMAND_TTL_MS: '30000',
    PREDDITA_COMMAND_LEASE_MS: '800',
    PREDDITA_COMMAND_EXECUTION_LEASE_MS: '3000',
    PREDDITA_DEVICE_STALE_MS: '30000',
    PREDDITA_PRIVACY_CONTROLLER_NAME: 'Condominio Smoke',
    PREDDITA_PRIVACY_CONTACT_EMAIL: 'lgpd.smoke@example.com',
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
  await assertProductionRejectsLegacyAuth();
  await assertProductionRejectsMissingAdminUsers();
  await assertProductionRejectsMissingMfaKey();
  await waitForServer();

  const health = await requestOk('/api/healthz');
  if (health.appVersion !== EXPECTED_ADMIN_VERSION) {
    throw new Error('Healthcheck deveria expor a versao v2.');
  }

  const unauthorized = await request('/api/admin/state');
  if (unauthorized.response.status !== 401) {
    throw new Error('Admin sem sessao deveria receber 401.');
  }
  if (!unauthorized.response.headers.get('x-request-id')) {
    throw new Error('Respostas da API deveriam expor um identificador de requisicao.');
  }

  const legacyAdminToken = await request('/api/admin/state', {
    headers: { 'x-admin-token': 'v2-admin-test-token' },
  });
  if (legacyAdminToken.response.status !== 401) {
    throw new Error('Token administrativo legado deveria estar desabilitado por padrao.');
  }

  const invalidLogin = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'sindico-smoke', password: 'senha-invalida' }),
  });
  if (invalidLogin.response.status !== 401 || invalidLogin.payload.error !== 'Usuario ou senha invalidos.') {
    throw new Error('Login invalido deveria falhar sem revelar qual credencial divergiu.');
  }

  const adminHeaders = await login('sindico-smoke', SINDICO_PASSWORD);
  const operatorHeaders = await login('operador-smoke', OPERATOR_PASSWORD);
  const superAdminHeaders = await login('preddita-smoke', SUPER_ADMIN_PASSWORD);

  const operatorPrivacy = await request('/api/admin/privacy', { headers: operatorHeaders });
  if (operatorPrivacy.response.status !== 403) {
    throw new Error('Operador nao deveria consultar a politica de privacidade.');
  }
  const privacy = await requestOk('/api/admin/privacy', { headers: adminHeaders });
  if (
    privacy.privacy?.policy?.controllerName !== 'Condominio Smoke'
    || privacy.privacy?.policy?.contactEmail !== 'lgpd.smoke@example.com'
    || privacy.privacy?.policy?.terminalCredentialRetention !== 'immediate'
  ) {
    throw new Error('Sindico deveria consultar a politica de privacidade configurada.');
  }

  const sindicoState = await requestOk('/api/admin/state', { headers: adminHeaders });
  if (sindicoState.state.session?.role !== 'sindico' || sindicoState.state.platform !== null) {
    throw new Error('Token de sindico deveria abrir apenas o painel operacional.');
  }

  const superState = await requestOk('/api/admin/state', { headers: superAdminHeaders });
  if (superState.state.session?.role !== 'super_admin' || !superState.state.platform?.lockers?.length) {
    throw new Error('Sessao PREDDITA deveria abrir o Admin Geral com resumo de armarios.');
  }
  if (
    superState.state.runtime?.operationalLogStorage !== 'jsonl'
    || superState.state.runtime?.operationalLogSchemaVersion !== 1
  ) {
    throw new Error('Runtime JSON deveria informar o armazenamento dos logs operacionais.');
  }

  const restrictedUpdate = await request('/api/admin/update-policy', {
    method: 'PUT',
    headers: adminHeaders,
    body: JSON.stringify({ enabled: false, channel: 'lab', rolloutPercentage: 0 }),
  });
  if (restrictedUpdate.response.status !== 403) {
    throw new Error('Sindico nao deveria gerenciar a distribuicao de APK.');
  }

  const invalidUpdate = await request('/api/admin/update-policy', {
    method: 'PUT',
    headers: superAdminHeaders,
    body: JSON.stringify({
      enabled: true,
      channel: 'lab',
      rolloutPercentage: 100,
      automaticPauseEnabled: true,
      failureThresholdPercentage: 50,
      minimumHealthSamples: 1,
      releaseId: 'v2.0.22-lab',
      versionCode: 22,
      versionName: '2.0.22-lab',
      apkUrl: 'http://downloads.example.com/preddita.apk',
      sha256: 'a'.repeat(64),
    }),
  });
  if (invalidUpdate.response.status !== 400) {
    throw new Error('Politica de atualizacao com URL sem HTTPS deveria ser recusada.');
  }

  const mismatchedChannelUpdate = await request('/api/admin/update-policy', {
    method: 'PUT',
    headers: superAdminHeaders,
    body: JSON.stringify({
      enabled: true,
      channel: 'pilot',
      rolloutPercentage: 10,
      releaseId: 'v2.0.22-lab',
      versionCode: 22,
      versionName: '2.0.22-lab',
      apkUrl: 'https://downloads.example.com/preddita.apk',
      sha256: 'a'.repeat(64),
    }),
  });
  if (mismatchedChannelUpdate.response.status !== 400) {
    throw new Error('VersionName deveria corresponder ao canal de distribuicao.');
  }

  const publishedUpdate = await requestOk('/api/admin/update-policy', {
    method: 'PUT',
    headers: superAdminHeaders,
    body: JSON.stringify({
      enabled: true,
      channel: 'lab',
      rolloutPercentage: 100,
      automaticPauseEnabled: true,
      failureThresholdPercentage: 50,
      minimumHealthSamples: 1,
      releaseId: 'v2.0.22-lab',
      versionCode: 22,
      versionName: '2.0.22-lab',
      apkUrl: 'https://github.com/PredditaTi/Locker-Preddita/releases/download/v2.0.22-lab/PREDDITA-Locker-2.0.22-lab-release.apk',
      sha256: 'a'.repeat(64),
      notes: 'Smoke test de distribuicao segura.',
    }),
  });
  if (!publishedUpdate.appUpdate?.enabled || publishedUpdate.appUpdate?.versionCode !== 22) {
    throw new Error('Admin Geral deveria publicar a politica de atualizacao por locker.');
  }

  const restrictedLogs = await request('/api/admin/logs', { headers: adminHeaders });
  if (restrictedLogs.response.status !== 403) {
    throw new Error('Sindico nao deveria consultar logs operacionais.');
  }
  const loginLogs = await requestOk('/api/admin/logs?event=admin-login&limit=2', {
    headers: superAdminHeaders,
  });
  if (!loginLogs.logs.length || loginLogs.logs.some((log) => !log.event.includes('admin-login'))) {
    throw new Error('Admin Geral deveria filtrar logs estruturados por evento.');
  }
  const warningLogs = await requestOk('/api/admin/logs?level=warn&event=admin-login-rejected', {
    headers: superAdminHeaders,
  });
  if (warningLogs.logs[0]?.event !== 'admin-login-rejected') {
    throw new Error('Tentativa de login recusada deveria gerar log de alerta.');
  }
  const allOperationalLogs = await requestOk('/api/admin/logs?limit=200', {
    headers: superAdminHeaders,
  });
  const serializedOperationalLogs = JSON.stringify(allOperationalLogs.logs);
  if (
    serializedOperationalLogs.includes('senha-invalida')
    || serializedOperationalLogs.includes(SUPER_ADMIN_PASSWORD)
    || serializedOperationalLogs.includes(DEVICE_KEY)
  ) {
    throw new Error('Logs operacionais nao podem expor credenciais.');
  }
  const operationalLogsCsv = await fetch(
    `http://127.0.0.1:${PORT}/api/admin/export/logs.csv?event=admin-login`,
    { headers: superAdminHeaders }
  ).then((response) => response.text());
  if (!operationalLogsCsv.includes('occurredAt;level;event') || !operationalLogsCsv.includes('admin-login')) {
    throw new Error('Exportacao CSV deveria respeitar os filtros de logs operacionais.');
  }

  const adminWithoutCsrf = await request('/api/admin/residents', {
    method: 'POST',
    headers: { cookie: adminHeaders.cookie },
    body: JSON.stringify({ apartment: 'SEM-CSRF' }),
  });
  if (adminWithoutCsrf.response.status !== 403) {
    throw new Error('Mutacao administrativa sem CSRF deveria receber 403.');
  }

  const crossLocker = await request('/api/admin/state?lockerId=locker-nao-autorizado', {
    headers: adminHeaders,
  });
  if (crossLocker.response.status !== 403) {
    throw new Error('Sindico nao deveria acessar outro locker pela query string.');
  }

  const operatorMutation = await request('/api/admin/residents', {
    method: 'POST',
    headers: operatorHeaders,
    body: JSON.stringify({ apartment: 'OPERADOR' }),
  });
  if (operatorMutation.response.status !== 403) {
    throw new Error('Operador nao deveria cadastrar apartamentos.');
  }

  const operatorExport = await request('/api/admin/export/residents.csv', {
    headers: operatorHeaders,
  });
  if (operatorExport.response.status !== 403) {
    throw new Error('Operador nao deveria exportar dados pessoais.');
  }

  const legacyDeviceAuth = await request('/api/device/snapshot', {
    headers: { 'x-device-key': DEVICE_KEY, 'x-locker-id': 'ks1062-aurora' },
  });
  if (legacyDeviceAuth.response.status !== 401) {
    throw new Error('Modo HMAC deveria recusar a chave estatica sem assinatura.');
  }

  const expiredDeviceAuth = await request('/api/device/snapshot', {
    deviceAuth: true,
    deviceAuthOptions: {
      timestamp: Date.now() - 61000,
      nonce: 'expired-smoke-nonce-0001',
    },
  });
  if (expiredDeviceAuth.response.status !== 401) {
    throw new Error('Assinatura HMAC vencida deveria receber 401.');
  }

  const signedStatusBody = JSON.stringify({ device: { online: false, serialOpen: false } });
  const tamperedDeviceBody = await request('/api/device/status', {
    method: 'POST',
    deviceAuth: true,
    deviceAuthOptions: {
      body: signedStatusBody,
      nonce: 'tampered-smoke-nonce-001',
    },
    body: JSON.stringify({ device: { online: true, serialOpen: true } }),
  });
  if (tamperedDeviceBody.response.status !== 401) {
    throw new Error('Corpo diferente do hash assinado deveria receber 401.');
  }

  const replayAuthOptions = {
    timestamp: Date.now(),
    nonce: 'replay-smoke-nonce-00001',
  };
  const firstSignedRequest = await request('/api/device/snapshot', {
    deviceAuth: true,
    deviceAuthOptions: replayAuthOptions,
  });
  const replayedSignedRequest = await request('/api/device/snapshot', {
    deviceAuth: true,
    deviceAuthOptions: replayAuthOptions,
  });
  if (!firstSignedRequest.response.ok || replayedSignedRequest.response.status !== 401) {
    throw new Error('Nonce HMAC reutilizado deveria ser bloqueado como replay.');
  }

  const createdResident = await requestOk('/api/admin/residents', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      phone: '47999990000',
      email: 'teste.v2@example.com',
      floor: '9',
      apartment: '901',
      building: 'Torre Teste',
    }),
  });

  const disposableResident = await requestOk('/api/admin/residents', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      email: 'eliminar.v2@example.com',
      apartment: '903',
      building: 'Torre Teste',
    }),
  });
  const erasedResident = await requestOk(
    `/api/admin/residents/${encodeURIComponent(disposableResident.resident.id)}`,
    { method: 'DELETE', headers: adminHeaders }
  );
  if (erasedResident.anonymizedDeliveryCount !== 0) {
    throw new Error('Cadastro sem entregas deveria ser eliminado sem historico associado.');
  }

  const operatorState = await requestOk('/api/admin/state', { headers: operatorHeaders });
  const operatorResident = operatorState.state.residents.find((resident) => resident.apartment === '901');
  if (!operatorResident || 'email' in operatorResident || 'phone' in operatorResident) {
    throw new Error('Operador deveria receber apartamento sem e-mail ou telefone.');
  }

  const residentsCsv = await fetch(`http://127.0.0.1:${PORT}/api/admin/export/residents.csv`, {
    headers: adminHeaders,
  }).then((response) => response.text());
  if (!residentsCsv.includes('901') || !residentsCsv.includes('teste.v2@example.com')) {
    throw new Error('Exportacao CSV de apartamentos nao contem o cadastro criado.');
  }

  const offlineOpen = await request('/api/admin/doors/2/open', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ reason: 'Nao deve abrir offline', requestedBy: 'codex' }),
  });
  if (offlineOpen.response.status !== 409) {
    throw new Error('Abertura remota deveria ser recusada quando o armario esta offline.');
  }

  const wrongLockerStatus = await request('/api/device/status', {
    method: 'POST',
    deviceAuth: true,
    body: JSON.stringify({
      lockerId: 'locker-errado',
      device: { online: true, serialOpen: true },
    }),
  });
  if (wrongLockerStatus.response.status !== 403) {
    throw new Error('Status de outro locker deveria ser recusado com 403.');
  }

  const oldDepositedAt = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
  await requestOk('/api/device/status', {
    method: 'POST',
    deviceAuth: true,
    body: JSON.stringify({
      device: {
        online: true,
        serialOpen: true,
        serialPath: '/dev/ttyS5',
        bridgeVersion: 'SMOKE-BRIDGE',
        board: 1,
        doorCount: 10,
        residentCount: 2,
        appUpdater: {
          available: true,
          currentVersionCode: 21,
          currentVersionName: '2.0.21-lab',
          status: 'idle',
          progressPercentage: 0,
        },
        commandWakeup: {
          enabled: false,
          state: 'disabled',
          connected: false,
          transport: 'http-polling',
          reconnectAttempt: 0,
        },
      },
      doors: Array.from({ length: 10 }, (_, index) => ({
        channel: index + 1,
        label: `Porta ${index + 1}`,
        size: index < 2 ? 'G' : index === 2 ? 'M' : 'P',
        status: 'closed',
        ...(index === 3 ? {
          delivery: {
            id: 'delivery-smoke-notify',
            recipientName: 'Morador Protegido',
            unit: 'Torre Teste - 9 andar - Ap 901',
            status: 'stored',
          },
        } : {}),
      })),
      deliveries: [
        {
          id: 'delivery-smoke-notify',
          recipientId: createdResident.resident.id,
          recipientName: 'Apartamento 901',
          recipientEmail: 'teste.v2@example.com',
          unit: 'Torre Teste - 9 andar - Ap 901',
          building: 'Torre Teste',
          size: 'P',
          door: 4,
          doorSize: 'P',
          pin: '123456',
          token: 'SMOKE-TOKEN',
          qrPayload: 'preddita://collect?id=delivery-smoke-notify&token=SMOKE-TOKEN',
          status: 'stored',
          createdAt: oldDepositedAt,
          depositedAt: oldDepositedAt,
        },
        {
          id: 'delivery-smoke-old-reminder',
          recipientId: 'resident-smoke-old',
          recipientName: 'Apartamento 902',
          recipientEmail: 'teste.v2@example.com',
          unit: 'Torre Teste - 9 andar - Ap 902',
          building: 'Torre Teste',
          size: 'P',
          door: 8,
          doorSize: 'P',
          pin: '777888',
          token: 'SMOKE-OLD-TOKEN',
          qrPayload: 'preddita://collect?id=delivery-smoke-old-reminder&token=SMOKE-OLD-TOKEN',
          status: 'stored',
          createdAt: oldDepositedAt,
          depositedAt: oldDepositedAt,
        },
      ],
    }),
  });

  const mqttTicket = await requestOk('/api/device/mqtt-ticket', { deviceAuth: true });
  if (mqttTicket.enabled !== false || mqttTicket.mode !== 'disabled' || mqttTicket.url) {
    throw new Error('Servidor sem AWS IoT deveria manter apenas o polling HTTP e nao emitir URL assinada.');
  }

  const updateSnapshot = await requestOk('/api/device/snapshot', { deviceAuth: true });
  if (
    updateSnapshot.appUpdate?.releaseId !== 'v2.0.22-lab'
    || updateSnapshot.appUpdate?.versionCode !== 22
    || updateSnapshot.appUpdate?.sha256 !== 'a'.repeat(64)
  ) {
    throw new Error('Locker elegivel deveria receber o manifesto de atualizacao no snapshot autenticado.');
  }
  const updateAdminState = await requestOk('/api/admin/state', { headers: superAdminHeaders });
  if (
    updateAdminState.state.device?.appUpdater?.currentVersionCode !== 21
    || updateAdminState.state.runtime?.deviceAppUpdateStatus !== 'idle'
    || updateAdminState.state.runtime?.iotMode !== 'disabled'
    || updateAdminState.state.runtime?.deviceCommandWakeupState !== 'disabled'
  ) {
    throw new Error('Painel deveria receber a telemetria do atualizador e do transporte de comandos.');
  }

  await requestOk('/api/device/status', {
    method: 'POST',
    deviceAuth: true,
    body: JSON.stringify({
      device: {
        appUpdater: {
          available: true,
          currentVersionCode: 22,
          currentVersionName: '2.0.22-lab',
          status: 'degraded',
          releaseId: 'v2.0.22-lab',
          targetVersionCode: 22,
          targetVersionName: '2.0.22-lab',
          healthFailureCode: 'SERIAL_IO_FAILURE',
          health: {
            appStarted: true,
            webViewReady: true,
            edgeAgentReady: true,
            stateLoaded: true,
            configurationBackupChecked: true,
            configurationBackupValid: true,
            credentialAvailable: true,
            serialClassified: true,
            serialHealthy: false,
            serialErrorCode: 'SERIAL_IO_FAILURE',
            checkedAt: new Date().toISOString(),
          },
        },
      },
    }),
  });
  await requestOk('/api/device/status', {
    method: 'POST',
    deviceAuth: true,
    body: JSON.stringify({
      device: {
        appUpdater: {
          available: true,
          currentVersionCode: 22,
          currentVersionName: '2.0.22-lab',
          status: 'healthy',
          releaseId: 'v2.0.22-lab',
          targetVersionCode: 22,
          targetVersionName: '2.0.22-lab',
          healthFailureCode: '',
          health: {
            serialClassified: true,
            serialHealthy: true,
            serialErrorCode: '',
            checkedAt: new Date().toISOString(),
          },
        },
      },
    }),
  });
  const healthyUpdateState = await requestOk('/api/admin/state', { headers: superAdminHeaders });
  if (
    !healthyUpdateState.state.appUpdate?.enabled
    || healthyUpdateState.state.appUpdate?.healthSummary?.healthyCount !== 1
    || healthyUpdateState.state.device?.appUpdater?.healthFailureCode
    || healthyUpdateState.state.device?.appUpdater?.health?.serialErrorCode
  ) {
    throw new Error('Locker saudavel deveria limpar a causa sem pausar a distribuicao.');
  }

  await requestOk('/api/device/status', {
    method: 'POST',
    deviceAuth: true,
    body: JSON.stringify({
      device: {
        appUpdater: {
          available: true,
          currentVersionCode: 21,
          currentVersionName: '2.0.21-lab',
          status: 'failed-health',
          releaseId: 'v2.0.22-lab',
          targetVersionCode: 22,
          targetVersionName: '2.0.22-lab',
          progressPercentage: 100,
          healthFailureCode: 'WEBVIEW_START_TIMEOUT',
          health: {
            appStarted: true,
            webViewReady: false,
            edgeAgentReady: false,
            stateLoaded: false,
            configurationBackupChecked: true,
            configurationBackupValid: true,
            credentialAvailable: true,
            serialClassified: true,
            serialHealthy: true,
            checkedAt: new Date().toISOString(),
          },
        },
      },
    }),
  });
  const pausedUpdateState = await requestOk('/api/admin/state', { headers: superAdminHeaders });
  if (
    pausedUpdateState.state.appUpdate?.enabled
    || !pausedUpdateState.state.appUpdate?.autoPausedAt
    || pausedUpdateState.state.appUpdate?.healthSummary?.failureCount !== 1
    || pausedUpdateState.state.device?.appUpdater?.recommendedAction?.includes('versao superior assinada') !== true
  ) {
    throw new Error('Health check falho deveria pausar o rollout e orientar recuperacao segura.');
  }
  const pausedUpdateSnapshot = await requestOk('/api/device/snapshot', { deviceAuth: true });
  if (pausedUpdateSnapshot.appUpdate !== null) {
    throw new Error('Locker com health check falho nao deveria receber novamente a mesma release.');
  }

  const residentExportResponse = await fetch(
    `http://127.0.0.1:${PORT}/api/admin/privacy/residents/${encodeURIComponent(createdResident.resident.id)}/export`,
    { headers: adminHeaders }
  );
  const residentExportText = await residentExportResponse.text();
  if (
    !residentExportResponse.ok
    || !String(residentExportResponse.headers.get('cache-control')).includes('no-store')
    || !residentExportText.includes('teste.v2@example.com')
    || residentExportText.includes('123456')
    || residentExportText.includes('SMOKE-TOKEN')
    || residentExportText.includes('preddita://collect')
  ) {
    throw new Error('Exportacao do titular deveria conter seus dados sem revelar credenciais de retirada.');
  }

  const deliveriesCsv = await fetch(`http://127.0.0.1:${PORT}/api/admin/export/deliveries.csv`, {
    headers: adminHeaders,
  }).then((response) => response.text());
  if (
    !deliveriesCsv.includes('credentialsErasedAt')
    || deliveriesCsv.includes(';pin;')
    || deliveriesCsv.includes('123456')
    || deliveriesCsv.includes('SMOKE-TOKEN')
  ) {
    throw new Error('CSV de entregas nao deveria expor PIN, token ou QR.');
  }

  const activeResidentErasure = await request(
    `/api/admin/residents/${encodeURIComponent(createdResident.resident.id)}`,
    { method: 'DELETE', headers: adminHeaders }
  );
  if (activeResidentErasure.response.status !== 409) {
    throw new Error('Eliminacao deveria ser bloqueada enquanto o apartamento possui entrega ativa.');
  }

  const protectedOperatorState = await requestOk('/api/admin/state', { headers: operatorHeaders });
  const protectedDelivery = protectedOperatorState.state.deliveries.find(
    (delivery) => delivery.id === 'delivery-smoke-notify'
  );
  const protectedDoor = protectedOperatorState.state.doors.find(
    (door) => door.delivery?.id === 'delivery-smoke-notify'
  );
  const commissionedMediumDoor = protectedOperatorState.state.doors.find(
    (door) => door.channel === 3
  );
  if (commissionedMediumDoor?.size !== 'M') {
    throw new Error('Mapa remoto deveria preservar o tamanho fisico comissionado.');
  }
  const serializedOperatorState = JSON.stringify(protectedOperatorState.state);
  if (
    !protectedDelivery
    || !protectedDoor
    || 'recipientName' in protectedDelivery
    || 'recipientEmail' in protectedDelivery
    || 'pin' in protectedDelivery
    || 'token' in protectedDelivery
    || 'qrPayload' in protectedDelivery
    || 'recipientName' in (protectedDoor?.delivery || {})
    || serializedOperatorState.includes('teste.v2@example.com')
    || serializedOperatorState.includes('SMOKE-TOKEN')
  ) {
    throw new Error('Operador recebeu dados pessoais ou credenciais de retirada protegidas.');
  }

  const notify = await requestOk('/api/admin/deliveries/delivery-smoke-notify/notify', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ requestedBy: 'smoke' }),
  });
  if (!['failed', 'sent'].includes(notify.notification.status)) {
    throw new Error('Reenvio de notificacao deveria retornar sent ou failed.');
  }

  const operatorNotify = await requestOk('/api/admin/deliveries/delivery-smoke-notify/notify', {
    method: 'POST',
    headers: operatorHeaders,
    body: JSON.stringify({}),
  });
  const operatorStateAfterNotify = await requestOk('/api/admin/state', { headers: operatorHeaders });
  if (
    JSON.stringify(operatorNotify).includes('teste.v2@example.com')
    || JSON.stringify(operatorStateAfterNotify.state).includes('teste.v2@example.com')
  ) {
    throw new Error('Reenvio ou auditoria revelou e-mail ao operador.');
  }

  const offlineDelivery = {
    id: 'delivery-smoke-offline-sync',
    recipientId: createdResident.resident.id,
    recipientName: 'Apartamento 901',
    recipientEmail: 'teste.v2@example.com',
    unit: 'Torre Teste - 9 andar - Ap 901',
    building: 'Torre Teste',
    size: 'P',
    door: 5,
    doorSize: 'P',
    pin: '654321',
    token: 'SMOKE-OFFLINE-TOKEN',
    qrPayload: 'preddita://collect?id=delivery-smoke-offline-sync&token=SMOKE-OFFLINE-TOKEN',
    status: 'stored',
    createdAt: new Date().toISOString(),
    depositedAt: new Date().toISOString(),
    labelPhotoDataUrl: 'data:image/jpeg;base64,Zm90by1ldGlxdWV0YS1zbW9rZQ==',
    labelPhotoCapturedAt: new Date().toISOString(),
    labelOcrStatus: 'photo-captured',
    labelOcrApartment: '901',
    labelOcrConfidence: 1,
    labelProofRequired: true,
  };
  const eventSync = await requestOk('/api/device/events', {
    method: 'POST',
    deviceAuth: true,
    body: JSON.stringify({
      events: [
        {
          id: 'event-smoke-offline-stored',
          type: 'delivery-stored',
          occurredAt: new Date().toISOString(),
          payload: { delivery: offlineDelivery, sendEmail: true },
        },
        {
          id: 'event-smoke-offline-collected',
          type: 'delivery-collected',
          occurredAt: new Date().toISOString(),
          payload: {
            delivery: { ...offlineDelivery, status: 'collected', collectedAt: new Date().toISOString() },
            source: 'smoke-offline-replay',
          },
        },
        {
          id: 'event-smoke-pilot-metric',
          type: 'pilot-metric',
          occurredAt: new Date().toISOString(),
          payload: {
            schemaVersion: 1,
            journeyType: 'pickup',
            outcome: 'completed',
            durationMs: 47000,
            pickupMode: 'pin',
            usedSizeFallback: false,
            helpRequested: true,
            errorCount: 1,
            reasonCode: 'none',
            apartment: '901',
            pin: '654321',
          },
        },
      ],
    }),
  });
  if (
    !eventSync.acceptedIds.includes('event-smoke-offline-stored') ||
    !eventSync.acceptedIds.includes('event-smoke-offline-collected') ||
    !eventSync.acceptedIds.includes('event-smoke-pilot-metric') ||
    !eventSync.notifications.some((item) => item.deliveryId === offlineDelivery.id)
  ) {
    throw new Error('Sincronizacao offline deveria aceitar eventos e devolver status de notificacao.');
  }

  const duplicateReplay = await requestOk('/api/device/events', {
    method: 'POST',
    deviceAuth: true,
    body: JSON.stringify({
      events: [
        {
          id: 'event-smoke-offline-stored',
          type: 'delivery-stored',
          occurredAt: new Date().toISOString(),
          payload: { delivery: offlineDelivery, sendEmail: true },
        },
      ],
    }),
  });
  if (
    !duplicateReplay.acceptedIds.includes('event-smoke-offline-stored') ||
    duplicateReplay.notifications.some((item) => item.deliveryId === offlineDelivery.id) ||
    duplicateReplay.failedEvents.length
  ) {
    throw new Error('Replay de evento offline ja processado deve ser idempotente e nao reenviar notificacao.');
  }

  const lateStoredReplay = await requestOk('/api/device/events', {
    method: 'POST',
    deviceAuth: true,
    body: JSON.stringify({
      events: [{
        id: 'event-smoke-late-stored-after-collection',
        type: 'delivery-stored',
        occurredAt: new Date().toISOString(),
        payload: { delivery: offlineDelivery, sendEmail: true },
      }],
    }),
  });
  if (
    !lateStoredReplay.acceptedIds.includes('event-smoke-late-stored-after-collection')
    || lateStoredReplay.notifications.some((item) => item.deliveryId === offlineDelivery.id)
  ) {
    throw new Error('Evento atrasado de deposito nao deveria reabrir uma entrega coletada.');
  }

  const terminalResend = await request('/api/admin/deliveries/delivery-smoke-offline-sync/notify', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({}),
  });
  if (terminalResend.response.status !== 409) {
    throw new Error('Entrega coletada nao deveria permitir reenvio de PIN ou QR.');
  }

  const retentionRun = await requestOk('/api/admin/privacy/retention/run', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({}),
  });
  if (!retentionRun.privacy?.lastAppliedAt || !retentionRun.result) {
    throw new Error('Execucao manual da retencao deveria retornar resultado auditavel.');
  }

  const created = await requestOk('/api/admin/doors/4/open', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ reason: 'Smoke test v2', requestedBy: 'codex' }),
  });

  const firstSnapshot = await requestOk('/api/device/snapshot', { deviceAuth: true });
  if (firstSnapshot.lockerId !== 'ks1062-aurora') {
    throw new Error('Snapshot deveria expor o lockerId autenticado/configurado.');
  }
  const firstLease = firstSnapshot.commands.find((command) => command.id === created.command.id);
  if (!firstLease || firstLease.status !== 'leased' || !firstLease.leaseId || firstLease.deliveryAttempt !== 1) {
    throw new Error('Snapshot deveria entregar o comando com lease e primeira tentativa.');
  }

  const snapshotWhileLeased = await requestOk('/api/device/snapshot', { deviceAuth: true });
  if (snapshotWhileLeased.commands.some((command) => command.id === created.command.id)) {
    throw new Error('Comando com lease ativo nao deveria ser entregue para outra execucao.');
  }

  await delay(1000);
  const retrySnapshot = await requestOk('/api/device/snapshot', { deviceAuth: true });
  const retryLease = retrySnapshot.commands.find((command) => command.id === created.command.id);
  if (
    !retryLease ||
    retryLease.status !== 'leased' ||
    retryLease.leaseId === firstLease.leaseId ||
    retryLease.deliveryAttempt !== 2
  ) {
    throw new Error('Lease expirado deveria reentregar o mesmo comando com nova tentativa.');
  }

  const executionId = 'exec-smoke-open-door-4';
  const staleAck = await request(`/api/device/commands/${encodeURIComponent(created.command.id)}/ack`, {
    method: 'POST',
    deviceAuth: true,
    body: JSON.stringify({ leaseId: firstLease.leaseId, executionId }),
  });
  if (staleAck.response.status !== 409) {
    throw new Error('ACK com lease antigo deveria ser recusado com 409.');
  }

  const acknowledged = await requestOk(`/api/device/commands/${encodeURIComponent(created.command.id)}/ack`, {
    method: 'POST',
    deviceAuth: true,
    body: JSON.stringify({ leaseId: retryLease.leaseId, executionId }),
  });
  if (acknowledged.command.status !== 'executing' || acknowledged.command.executionId !== executionId) {
    throw new Error('ACK valido deveria registrar a execucao antes do acionamento fisico.');
  }

  const duplicateAck = await requestOk(`/api/device/commands/${encodeURIComponent(created.command.id)}/ack`, {
    method: 'POST',
    deviceAuth: true,
    body: JSON.stringify({ leaseId: retryLease.leaseId, executionId }),
  });
  if (duplicateAck.duplicate !== true) {
    throw new Error('Replay do mesmo ACK deveria ser idempotente.');
  }

  const snapshotWhileExecuting = await requestOk('/api/device/snapshot', { deviceAuth: true });
  if (snapshotWhileExecuting.commands.some((command) => command.id === created.command.id)) {
    throw new Error('Comando em execucao nao deveria ser reentregue com lease ativo.');
  }

  const unknownComplete = await request('/api/device/commands/comando-inexistente/complete', {
    method: 'POST',
    deviceAuth: true,
    body: JSON.stringify({
      ok: true,
      releasedDoor: true,
      door: 2,
      at: new Date().toISOString(),
    }),
  });
  if (unknownComplete.response.status !== 404) {
    throw new Error('Conclusao de comando inexistente deveria receber 404.');
  }

  const conflictingCompletion = await request(`/api/device/commands/${encodeURIComponent(created.command.id)}/complete`, {
    method: 'POST',
    deviceAuth: true,
    body: JSON.stringify({ ok: true, executionId: 'exec-conflitante', door: 4 }),
  });
  if (conflictingCompletion.response.status !== 409) {
    throw new Error('Conclusao de outra execucao deveria ser recusada com 409.');
  }

  const completionPayload = {
    ok: true,
    confirmed: true,
    reason: 'confirmed',
    executionId,
    door: 4,
    releasedDoor: true,
    pendingPhysicalClose: true,
    at: new Date().toISOString(),
  };
  const completion = await requestOk(`/api/device/commands/${encodeURIComponent(created.command.id)}/complete`, {
    method: 'POST',
    deviceAuth: true,
    body: JSON.stringify(completionPayload),
  });
  if (completion.duplicate !== false) {
    throw new Error('Primeira conclusao deveria aplicar o resultado uma unica vez.');
  }

  const duplicateCompletion = await requestOk(`/api/device/commands/${encodeURIComponent(created.command.id)}/complete`, {
    method: 'POST',
    deviceAuth: true,
    body: JSON.stringify({ ...completionPayload, retriedAt: new Date().toISOString() }),
  });
  if (duplicateCompletion.duplicate !== true) {
    throw new Error('Replay da conclusao deveria retornar sucesso idempotente.');
  }

  const commandStatus = await requestOk(`/api/admin/commands/${encodeURIComponent(created.command.id)}`, {
    headers: adminHeaders,
  });
  if (commandStatus.command.status !== 'completed' || commandStatus.command.result?.confirmed !== true) {
    throw new Error('Comando deveria finalizar como completed/confirmed.');
  }
  if (commandStatus.command.result?.releasedDoor !== false) {
    throw new Error('Servidor nao deve liberar porta sem prova fisica de fechamento.');
  }

  const state = await requestOk('/api/admin/state', { headers: adminHeaders });
  if (!state.state.runtime || state.state.runtime.appVersion !== EXPECTED_ADMIN_VERSION) {
    throw new Error('Resumo runtime v2 nao foi exposto no estado admin.');
  }
  const pilotMetric = state.state.pilot?.metrics?.find((metric) => metric.eventId === 'event-smoke-pilot-metric');
  if (
    state.state.runtime.pilotSummary?.sampleCount !== 1
    || state.state.runtime.pilotSummary?.helpRequestCount !== 1
    || pilotMetric?.journeyType !== 'pickup'
    || pilotMetric?.pickupMode !== 'pin'
    || 'apartment' in (pilotMetric || {})
    || 'pin' in (pilotMetric || {})
  ) {
    throw new Error('Metricas do piloto deveriam ser agregadas e remover dados identificaveis no servidor.');
  }
  if ((state.state.runtime.overdueDeliveryCount ?? 0) < 1 || (state.state.runtime.reminder48hCount ?? 0) < 1) {
    throw new Error('Runtime deveria destacar entregas aguardando retirada ha mais de 48h.');
  }
  const evidenceDelivery = state.state.deliveries.find((delivery) => delivery.id === offlineDelivery.id);
  if (!evidenceDelivery?.labelPhotoDataUrl || evidenceDelivery.labelOcrApartment !== '901') {
    throw new Error('Sincronizacao offline deveria preservar comprovante fotografico da etiqueta.');
  }
  if (state.state.doors[0]?.size !== 'G' || state.state.doors[1]?.size !== 'G' || state.state.doors[2]?.size !== 'M') {
    throw new Error('Perfil fisico deveria preservar o mapa de tamanhos enviado pelo locker.');
  }
  const releasedDelivery = state.state.deliveries.find((delivery) => delivery.id === 'delivery-smoke-notify');
  if (releasedDelivery?.status !== 'stored') {
    throw new Error('Entrega aberta remotamente deve permanecer ocupada enquanto aguarda fechamento.');
  }
  const offlineSyncedDelivery = state.state.deliveries.find((delivery) => delivery.id === offlineDelivery.id);
  if (offlineSyncedDelivery?.status !== 'collected') {
    throw new Error('Evento offline de retirada deveria liberar a entrega no painel.');
  }
  if (
    offlineSyncedDelivery.pin
    || offlineSyncedDelivery.token
    || offlineSyncedDelivery.qrPayload
    || !offlineSyncedDelivery.credentialsErasedAt
  ) {
    throw new Error('Entrega coletada deveria apagar PIN, token e QR imediatamente.');
  }
  if (!state.state.processedDeviceEvents.some((event) => event.id === 'event-smoke-offline-stored')) {
    throw new Error('Eventos offline processados deveriam ficar registrados para idempotencia.');
  }
  if (state.state.notificationOutbox?.some((item) => item.deliveryId === offlineDelivery.id)) {
    throw new Error('Coleta sincronizada deveria cancelar notificacoes pendentes da entrega.');
  }
  if (state.state.processedDeviceEvents.filter((event) => event.id === 'event-smoke-offline-stored').length !== 1) {
    throw new Error('Replay offline nao deveria duplicar o registro de idempotencia.');
  }
  if (!Array.isArray(state.state.runtime.securityWarnings)) {
    throw new Error('Resumo runtime deveria expor alertas de seguranca.');
  }
  const completionAudits = state.state.auditTrail.filter(
    (item) => item.kind === 'remote-open-completed' && item.meta?.commandId === created.command.id
  );
  if (completionAudits.length !== 1) {
    throw new Error('Conclusao repetida nao deveria duplicar auditoria ou efeitos do comando.');
  }

  await requestOk('/api/auth/logout', { method: 'POST', headers: adminHeaders });
  const loggedOutSession = await request('/api/auth/session', { headers: { cookie: adminHeaders.cookie } });
  if (loggedOutSession.response.status !== 401) {
    throw new Error('Logout deveria invalidar imediatamente a sessao administrativa.');
  }

  console.log('PREDDITA_V2_SMOKE_OK');
} finally {
  server.kill();
  await delay(300);
  rmSync(DATA_DIR, { recursive: true, force: true });
  if (server.exitCode && server.exitCode !== 0) {
    console.error(serverLog);
  }
}
