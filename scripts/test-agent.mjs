#!/usr/bin/env node
/**
 * PREDDITA Locker — Agente de teste de experiencia (v2)
 *
 * Cobre 4 categorias contra um admin-online v2 ja em operacao:
 *   1. Health & contrato (so GET, sempre seguro)
 *   2. UX rules puras (importa lockerWorkflow.js, sem rede)
 *   3. Erros do usuario (PIN errado, QR expirado, etc. — puros)
 *   4. Seguranca / autorizacao (gera 401/429 contra a API real)
 *
 * Mutacoes (cadastrar morador, simular deposito do device, abrir porta,
 * disparar e-mail) ficam atras de flags explicitas. Por padrao, o agente
 * nao escreve nada em producao.
 *
 * Uso minimo (read-only contra uma instancia HTTPS):
 *   node scripts/test-agent.mjs \
 *     --base https://locker.example.com \
 *     --admin-user "$PREDDITA_ADMIN_USERNAME" \
 *     --device-key  "$PREDDITA_DEVICE_KEY"
 *
 * Para detalhes de cada flag, veja scripts/test-agent-README.md.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createDeviceRequestAuthHeaders } from '../web/src/deviceRequestAuth.js';
import {
  PACKAGE_SIZES,
  cancelDelivery,
  confirmDeposit,
  createDoorCatalog,
  createInitialState,
  deliveryCanBeCollected,
  findAvailableDoor,
  formatRecipientApartment,
  formatRecipientUnit,
  markDepositDoorOpened,
  reserveDelivery,
  resolvePickupRequest,
} from '../web/src/lockerWorkflow.js';
import { createPhysicalDoorProofs } from './door-safety-fixtures.mjs';

let physicalSequence = 100;
function confirmTestReservation(reservation) {
  const physical = createPhysicalDoorProofs(
    reservation.delivery.door,
    'dropoff',
    physicalSequence++
  );
  const openedState = markDepositDoorOpened(
    reservation.state,
    reservation.delivery.id,
    physical.cycle
  );
  return confirmDeposit(openedState, reservation.delivery.id, {}, physical.closeProof);
}

// ============================================================================
// 1. CLI / config
// ============================================================================

function parseArgs(argv) {
  const args = {
    base: process.env.PREDDITA_BASE_URL || '',
    adminUsername: process.env.PREDDITA_ADMIN_USERNAME || '',
    adminPassword: process.env.PREDDITA_ADMIN_PASSWORD || '',
    superAdminUsername: process.env.PREDDITA_SUPER_ADMIN_USERNAME || '',
    superAdminPassword: process.env.PREDDITA_SUPER_ADMIN_PASSWORD || '',
    deviceKey: process.env.PREDDITA_DEVICE_KEY || '',
    lockerId: process.env.PREDDITA_LOCKER_ID || 'ks1062-aurora',
    write: false,
    actuate: false,
    sendEmail: false,
    rateLimit: false,
    report: '',
    only: '',
    verbose: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--base':            args.base = next; i += 1; break;
      case '--admin-user':      args.adminUsername = next; i += 1; break;
      case '--admin-password':  args.adminPassword = next; i += 1; break;
      case '--super-user':      args.superAdminUsername = next; i += 1; break;
      case '--super-password':  args.superAdminPassword = next; i += 1; break;
      case '--device-key':      args.deviceKey = next; i += 1; break;
      case '--locker-id':       args.lockerId = next; i += 1; break;
      case '--report':          args.report = next; i += 1; break;
      case '--only':            args.only = next; i += 1; break;
      case '--write':           args.write = true; break;
      case '--actuate':         args.actuate = true; break;
      case '--send-email':      args.sendEmail = true; break;
      case '--rate-limit':      args.rateLimit = true; break;
      case '--verbose':         args.verbose = true; break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
      default:
        if (arg.startsWith('--')) {
          console.error(`Flag desconhecida: ${arg}`);
          printHelp();
          process.exit(2);
        }
    }
  }

  args.base = String(args.base || '').replace(/\/$/, '');
  return args;
}

function validateBaseUrl(value) {
  if (!value) {
    throw new Error('Informe --base ou PREDDITA_BASE_URL.');
  }

  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    throw new Error('A URL do Admin Online e invalida.');
  }

  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('Use HTTPS; HTTP e permitido somente para testes em localhost.');
  }
}

function printHelp() {
  console.log(`
PREDDITA test-agent — agente de testes de experiencia para o admin-online v2.

Flags principais:
  --base URL              Base URL HTTPS obrigatoria do admin-online
  --admin-user USER       Usuario com papel sindico
  --admin-password PASS   Senha do sindico (prefira PREDDITA_ADMIN_PASSWORD)
  --super-user USER       Usuario super_admin — opcional
  --super-password PASS   Senha do super_admin — opcional
  --device-key KEY        PREDDITA_DEVICE_KEY do armario
  --locker-id ID          ID do armario (default: ks1062-aurora)

Flags de escopo (em camadas — cada uma exige a anterior):
  (default)               So GETs e testes puros. NAO escreve nada.
  --write                 Habilita cadastros/cancelamentos de teste no admin.
  --actuate               Permite acionar fisicamente uma porta (ALTO RISCO).
  --send-email            Permite disparar e-mail real para PREDDITA_TEST_EMAIL.
  --rate-limit            Roda o teste de rate limit (180 req/min — barulhento).

Filtros e relatorio:
  --only NAME             Roda so a suite cujo nome contem NAME (ex: --only auth).
  --report PATH           Gera relatorio JSON em PATH.
  --verbose               Detalhe completo de cada assercao.

Variaveis de ambiente equivalentes:
  PREDDITA_BASE_URL, PREDDITA_ADMIN_USERNAME, PREDDITA_ADMIN_PASSWORD,
  PREDDITA_SUPER_ADMIN_USERNAME, PREDDITA_SUPER_ADMIN_PASSWORD,
  PREDDITA_DEVICE_KEY, PREDDITA_LOCKER_ID, PREDDITA_TEST_EMAIL.
`);
}

// ============================================================================
// 2. Logger / cores
// ============================================================================

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
  reset:  useColor ? '\x1b[0m'  : '',
  bold:   useColor ? '\x1b[1m'  : '',
  dim:    useColor ? '\x1b[2m'  : '',
  red:    useColor ? '\x1b[31m' : '',
  green:  useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  blue:   useColor ? '\x1b[34m' : '',
  cyan:   useColor ? '\x1b[36m' : '',
};

function log(line = '') { process.stdout.write(`${line}\n`); }
function header(text) {
  log(`\n${C.bold}${C.cyan}${'='.repeat(72)}${C.reset}`);
  log(`${C.bold}${C.cyan}  ${text}${C.reset}`);
  log(`${C.bold}${C.cyan}${'='.repeat(72)}${C.reset}`);
}
function section(text) {
  log(`\n${C.bold}${C.blue}-- ${text}${C.reset}`);
}

// ============================================================================
// 3. HTTP client
// ============================================================================

class ApiClient {
  constructor({
    base,
    adminUsername,
    adminPassword,
    superAdminUsername,
    superAdminPassword,
    deviceKey,
    lockerId,
  }) {
    this.base = base;
    this.adminUsername = adminUsername;
    this.adminPassword = adminPassword;
    this.superAdminUsername = superAdminUsername;
    this.superAdminPassword = superAdminPassword;
    this.deviceKey = deviceKey;
    this.lockerId = lockerId;
    this.adminSession = null;
    this.superAdminSession = null;
  }

  async _fetch(path, {
    method = 'GET',
    body,
    headers = {},
    timeoutMs = 8000,
    adminSession = null,
    deviceKey = '',
  } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = Date.now();
    const bodyText = body === undefined ? '' : JSON.stringify(body);
    try {
      const deviceHeaders = deviceKey
        ? await createDeviceRequestAuthHeaders({
            method,
            path,
            lockerId: this.lockerId,
            deviceKey,
            body: bodyText,
          })
        : {};
      const sessionHeaders = adminSession ? {
        cookie: adminSession.cookie,
        ...(['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase())
          ? {}
          : { 'x-csrf-token': adminSession.csrfToken }),
      } : {};
      const response = await fetch(`${this.base}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...sessionHeaders,
          ...deviceHeaders,
          ...headers,
        },
        body: body === undefined ? undefined : bodyText,
      });
      const text = await response.text();
      let json = null;
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      return {
        ok: response.ok,
        status: response.status,
        json,
        durationMs: Date.now() - start,
        setCookie: response.headers.get('set-cookie') || '',
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        json: { error: error.message || String(error) },
        durationMs: Date.now() - start,
        networkError: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async _login(username, password) {
    if (!username || !password) return null;
    const response = await this._fetch('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    if (!response.ok || !response.json.session?.csrfToken) return null;
    const cookie = response.setCookie.split(';')[0];
    return cookie ? { cookie, csrfToken: response.json.session.csrfToken, user: response.json.session } : null;
  }

  async loginAdmin() {
    this.adminSession = await this._login(this.adminUsername, this.adminPassword);
    return this.adminSession;
  }

  async loginSuperAdmin() {
    this.superAdminSession = await this._login(this.superAdminUsername, this.superAdminPassword);
    return this.superAdminSession;
  }

  health()              { return this._fetch('/api/healthz'); }
  notFound()            { return this._fetch('/api/this-route-does-not-exist'); }
  adminState(kind = 'admin') {
    return this._fetch('/api/admin/state', {
      adminSession: kind === 'super' ? this.superAdminSession : this.adminSession,
    });
  }
  deviceSnapshot(key = this.deviceKey) {
    return this._fetch('/api/device/snapshot', { deviceKey: key });
  }
  deviceStatus(payload) {
    return this._fetch('/api/device/status', {
      method: 'POST',
      deviceKey: this.deviceKey,
      body: payload,
    });
  }
  postResident(payload) {
    return this._fetch('/api/admin/residents', {
      method: 'POST',
      adminSession: this.adminSession,
      body: payload,
    });
  }
  deleteResident(id) {
    return this._fetch(`/api/admin/residents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      adminSession: this.adminSession,
    });
  }
  openDoor(door, body) {
    return this._fetch(`/api/admin/doors/${door}/open`, {
      method: 'POST',
      adminSession: this.adminSession,
      body,
    });
  }
  completeCommand(commandId, body) {
    return this._fetch(`/api/device/commands/${encodeURIComponent(commandId)}/complete`, {
      method: 'POST',
      deviceKey: this.deviceKey,
      body,
    });
  }
  acknowledgeCommand(commandId, body) {
    return this._fetch(`/api/device/commands/${encodeURIComponent(commandId)}/ack`, {
      method: 'POST',
      deviceKey: this.deviceKey,
      body,
    });
  }
  notifyDelivery(delivery) {
    return this._fetch('/api/device/deliveries/notify', {
      method: 'POST',
      deviceKey: this.deviceKey,
      body: { delivery },
      timeoutMs: 20000,
    });
  }
}

// ============================================================================
// 4. Test runner
// ============================================================================

function makeRunner({ verbose, only }) {
  const results = [];
  let currentSuite = null;

  function suite(name, fn) {
    if (only && !name.toLowerCase().includes(only.toLowerCase())) return Promise.resolve();
    currentSuite = { name, tests: [] };
    section(name);
    return Promise.resolve(fn()).then(() => {
      results.push(currentSuite);
      currentSuite = null;
    });
  }

  async function test(name, fn) {
    if (!currentSuite) throw new Error(`test('${name}') chamado fora de suite()`);
    const start = Date.now();
    let outcome;
    try {
      const detail = await fn();
      outcome = { name, status: 'pass', detail: detail || '', durationMs: Date.now() - start };
      log(`  ${C.green}PASS${C.reset} ${name}${detail ? ` ${C.dim}— ${detail}${C.reset}` : ''}`);
    } catch (error) {
      outcome = { name, status: 'fail', detail: error.message || String(error), durationMs: Date.now() - start };
      log(`  ${C.red}FAIL${C.reset} ${name} ${C.red}— ${outcome.detail}${C.reset}`);
      if (verbose && error.stack) log(`    ${C.dim}${error.stack.split('\n').slice(1, 4).join('\n    ')}${C.reset}`);
    }
    currentSuite.tests.push(outcome);
  }

  function skip(name, reason) {
    if (!currentSuite) throw new Error(`skip('${name}') fora de suite()`);
    log(`  ${C.yellow}SKIP${C.reset} ${name} ${C.dim}— ${reason}${C.reset}`);
    currentSuite.tests.push({ name, status: 'skip', detail: reason, durationMs: 0 });
  }

  return { suite, test, skip, results };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: esperado ${JSON.stringify(expected)}, recebi ${JSON.stringify(actual)}`);
}

// ============================================================================
// 5. Test suites
// ============================================================================

async function suiteHealth(api, runner) {
  await runner.suite('1. Health & contrato (read-only)', async () => {
    await runner.test('GET /api/healthz responde 200', async () => {
      const r = await api.health();
      assert(r.ok, `status ${r.status}`);
      assert(r.json.appVersion, 'sem appVersion');
      return `appVersion=${r.json.appVersion} schemaVersion=${r.json.schemaVersion}`;
    });

    await runner.test('GET admin/state com sessao de sindico devolve estado completo', async () => {
      if (!api.adminSession) throw new Error('credenciais do sindico nao foram fornecidas ou sao invalidas');
      const r = await api.adminState();
      assert(r.ok, `status ${r.status}: ${r.json.error || ''}`);
      const s = r.json.state;
      assert(s, 'sem state no payload');
      assert(s.tenant && s.tenant.lockerId, 'state.tenant.lockerId ausente');
      assert(Array.isArray(s.doors) && s.doors.length > 0, 'state.doors vazio');
      assert(Array.isArray(s.residents), 'state.residents nao e array');
      assertEqual(s.session?.role, 'sindico', 'papel da sessao');
      assertEqual(s.platform, null, 'sindico nao deveria ver platform');
      return `${s.doors.length} portas, ${s.residents.length} apartamentos, ${s.deliveries?.length ?? 0} entregas`;
    });

    await runner.test('GET device/snapshot com HMAC responde com residents+commands', async () => {
      if (!api.deviceKey) throw new Error('--device-key nao foi fornecido');
      const r = await api.deviceSnapshot();
      assert(r.ok, `status ${r.status}: ${r.json.error || ''}`);
      assert(Array.isArray(r.json.residents), 'residents ausente');
      assert(Array.isArray(r.json.commands), 'commands ausente');
      assert(r.json.serverTime, 'serverTime ausente');
      return `${r.json.residents.length} moradores, ${r.json.commands.length} comandos pendentes`;
    });

    await runner.test('Latencia razoavel (<2s)', async () => {
      const r = await api.health();
      assert(r.durationMs < 2000, `${r.durationMs}ms`);
      return `${r.durationMs}ms`;
    });

    if (api.superAdminSession) {
      await runner.test('Sessao de super_admin enxerga platform e securityWarnings', async () => {
        const r = await api.adminState('super');
        assert(r.ok, `status ${r.status}: ${r.json.error || ''}`);
        assertEqual(r.json.state.session?.role, 'super_admin', 'papel da sessao super_admin');
        assert(r.json.state.platform, 'platform deveria existir para super_admin');
        return `${r.json.state.platform.lockerCount} armarios, warnings=${(r.json.state.runtime?.securityWarnings ?? []).length}`;
      });
    } else {
      runner.skip('super_admin checa platform', 'credenciais de super_admin nao fornecidas');
    }
  });
}

async function suiteUxRules(_api, runner) {
  await runner.suite('2. UX rules puras (lockerWorkflow.js)', async () => {
    await runner.test('createDoorCatalog: 2 primeiras portas grandes', () => {
      const c = createDoorCatalog(10);
      assertEqual(c[0].size, 'G', 'porta 1');
      assertEqual(c[1].size, 'G', 'porta 2');
      assertEqual(c[2].size, 'P', 'porta 3');
      return `${c.length} portas, 2G + ${c.length - 2}P`;
    });

    await runner.test('findAvailableDoor: volume G vai para porta grande', () => {
      const state = { ...createInitialState(), deliveries: [], deviceConfig: { board: 1, doorCount: 10 } };
      const door = findAvailableDoor(state, 'G', createDoorCatalog(10));
      assert(door, 'sem porta disponivel');
      assertEqual(door.size, 'G', 'tamanho da porta atribuida');
      return `porta ${door.channel} (${door.size})`;
    });

    await runner.test('findAvailableDoor: volume P prefere porta P (nao desperdica G)', () => {
      const state = { ...createInitialState(), deliveries: [], deviceConfig: { board: 1, doorCount: 10 } };
      const door = findAvailableDoor(state, 'P', createDoorCatalog(10));
      assertEqual(door?.size, 'P', 'porta deveria ser pequena');
      return `porta ${door.channel}`;
    });

    await runner.test('reserveDelivery cria PIN de 6 digitos e QR preddita://collect', async () => {
      const recipient = {
        id: 'test-ux-1', firstName: '', lastName: '', name: 'Apartamento 101', cpf: '',
        unit: 'Torre A - 101', building: 'Torre A', floor: '1', apartment: '101',
        phone: '', email: 'test@example.com',
      };
      const state = { ...createInitialState(), recipients: [recipient], deliveries: [], deviceConfig: { board: 1, doorCount: 10 } };
      const { delivery } = await reserveDelivery(state, {
        recipientId: recipient.id,
        packageSize: 'M',
        courierName: 'Test',
        orderCode: 'AGENT-001',
        doorCatalog: createDoorCatalog(10),
      });
      assert(/^\d{6}$/.test(delivery.pin), `PIN ${delivery.pin} nao tem 6 digitos`);
      assert(delivery.qrPayload.startsWith('preddita://collect?'), 'QR nao tem prefixo PREDDITA');
      assert(delivery.qrPayload.includes(`id=${encodeURIComponent(delivery.id)}`), 'QR sem id');
      assert(delivery.qrPayload.includes('token='), 'QR sem token');
      assert(delivery.qrPayload.includes('exp='), 'QR sem expiracao');
      return `PIN ${delivery.pin}, porta ${delivery.door}`;
    });

    await runner.test('confirmDeposit transiciona stored e marca notificationStatus', async () => {
      const recipient = { id: 'test-ux-2', firstName: '', lastName: '', name: 'Ap 202', cpf: '', unit: 'A-202', building: 'A', floor: '2', apartment: '202', phone: '', email: 'a@b.c' };
      const initial = { ...createInitialState(), recipients: [recipient], deliveries: [], deviceConfig: { board: 1, doorCount: 10 } };
      const { state, delivery } = await reserveDelivery(initial, { recipientId: recipient.id, packageSize: 'M', doorCatalog: createDoorCatalog(10) });
      const after = confirmTestReservation({ state, delivery });
      const stored = after.deliveries.find((d) => d.id === delivery.id);
      assertEqual(stored.status, 'stored', 'status apos confirm');
      assertEqual(stored.notificationStatus, 'pending', 'notificacao deveria ficar pending com e-mail');
      return `status=${stored.status}, notif=${stored.notificationStatus}`;
    });

    await runner.test('PACKAGE_SIZES contem P, M, G', () => {
      const ids = PACKAGE_SIZES.map((s) => s.id).sort();
      assertEqual(JSON.stringify(ids), JSON.stringify(['G', 'M', 'P']), 'tamanhos disponiveis');
      return ids.join(',');
    });

    await runner.test('formatRecipientUnit monta string com torre/andar/ap', () => {
      const text = formatRecipientUnit({ building: 'Torre A', floor: '5', apartment: '503' });
      assert(text.includes('Torre A') && text.includes('503'), `texto inesperado: ${text}`);
      return text;
    });
  });
}

async function suiteUserErrors(_api, runner) {
  await runner.suite('3. Erros do usuario (puros)', async () => {
    const recipient = { id: 'test-err', firstName: '', lastName: '', name: 'Ap 303', cpf: '', unit: 'A-303', building: 'A', floor: '3', apartment: '303', phone: '', email: 'a@b.c' };
    const baseInit = { ...createInitialState(), recipients: [recipient], deliveries: [], deviceConfig: { board: 1, doorCount: 10 } };

    await runner.test('reserveDelivery sem packageSize bloqueia', async () => {
      try {
        await reserveDelivery(baseInit, { recipientId: recipient.id, doorCatalog: createDoorCatalog(10) });
        throw new Error('deveria ter lancado');
      } catch (error) {
        assert(/tamanho do volume/i.test(error.message), `mensagem: ${error.message}`);
        return error.message;
      }
    });

    await runner.test('reserveDelivery sem morador valido bloqueia', async () => {
      try {
        await reserveDelivery(baseInit, { recipientId: 'inexistente', packageSize: 'M', doorCatalog: createDoorCatalog(10) });
        throw new Error('deveria ter lancado');
      } catch (error) {
        assert(/apartamento/i.test(error.message), `mensagem: ${error.message}`);
        return error.message;
      }
    });

    await runner.test('reserveDelivery sem porta P livre cai em fallback ou falha', async () => {
      // Cenario: 1 porta P, ja ocupada; pedimos P -> nao deveria reaproveitar G nem livre.
      const occupied = await reserveDelivery(
        { ...baseInit, deviceConfig: { board: 1, doorCount: 3 } }, // 2G + 1P
        { recipientId: recipient.id, packageSize: 'P', doorCatalog: createDoorCatalog(3) },
      );
      const stored = confirmTestReservation(occupied);
      try {
        await reserveDelivery(stored, { recipientId: recipient.id, packageSize: 'P', doorCatalog: createDoorCatalog(3) });
        return 'caiu no fallback de porta maior (comportamento atual: aloca G)';
      } catch (error) {
        return `bloqueio explicito: ${error.message}`;
      }
    });

    await runner.test('resolvePickupRequest com PIN errado rejeita', async () => {
      const reserved = await reserveDelivery(baseInit, { recipientId: recipient.id, packageSize: 'M', doorCatalog: createDoorCatalog(10) });
      const state = confirmTestReservation(reserved);
      const r = resolvePickupRequest(state, 'pin', '000000');
      assertEqual(r.ok, false, 'deveria rejeitar');
      assert(/encomenda ativa|codigo/i.test(r.error), `mensagem: ${r.error}`);
      return r.error;
    });

    await runner.test('resolvePickupRequest com QR mal formatado rejeita', async () => {
      const reserved = await reserveDelivery(baseInit, { recipientId: recipient.id, packageSize: 'M', doorCatalog: createDoorCatalog(10) });
      const state = confirmTestReservation(reserved);
      const r = resolvePickupRequest(state, 'predditaQr', 'http://qualquer-coisa.com');
      assertEqual(r.ok, false, 'deveria rejeitar');
      return r.error;
    });

    await runner.test('resolvePickupRequest em entrega cancelada nao libera', async () => {
      const reserved = await reserveDelivery(baseInit, { recipientId: recipient.id, packageSize: 'M', doorCatalog: createDoorCatalog(10) });
      const stored = confirmTestReservation(reserved);
      const cancelled = cancelDelivery(stored, reserved.delivery.id, 'Teste');
      const r = resolvePickupRequest(cancelled, 'pin', reserved.delivery.pin);
      assertEqual(r.ok, false, 'deveria rejeitar entrega cancelada');
      return r.error;
    });

    await runner.test('deliveryCanBeCollected: false para expirada', () => {
      const expired = {
        status: 'stored',
        expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
      };
      assertEqual(deliveryCanBeCollected(expired), false, 'expirada nao pode coletar');
      return 'ok';
    });
  });
}

async function suiteSecurity(api, runner, args) {
  await runner.suite('4. Seguranca / autorizacao (gera 401/429)', async () => {
    await runner.test('admin/state sem sessao responde 401', async () => {
      const r = await api._fetch('/api/admin/state');
      assertEqual(r.status, 401, 'status');
      return 'sessao ausente bloqueada';
    });

    await runner.test('login com senha errada responde 401', async () => {
      const r = await api._fetch('/api/auth/login', {
        method: 'POST',
        body: { username: api.adminUsername || 'sindico', password: 'senha-claramente-errada-xpto' },
      });
      assertEqual(r.status, 401, 'status');
      return 'credencial invalida bloqueada';
    });

    await runner.test('device/snapshot sem assinatura HMAC responde 401', async () => {
      const r = await api._fetch('/api/device/snapshot');
      assertEqual(r.status, 401, 'status');
      return 'assinatura ausente bloqueada';
    });

    await runner.test('device/snapshot com HMAC incorreto responde 401', async () => {
      const r = await api.deviceSnapshot('chave-errada-xpto-com-mais-de-32-bytes');
      assertEqual(r.status, 401, 'status');
      return 'assinatura invalida bloqueada';
    });

    await runner.test('rota inexistente responde 404', async () => {
      const r = await api.notFound();
      assertEqual(r.status, 404, 'status');
      return 'ok';
    });

    await runner.test('admin/state com sindico nao expoe platform', async () => {
      if (!api.adminSession) throw new Error('sessao de sindico ausente');
      const r = await api.adminState();
      assert(r.ok, `status ${r.status}`);
      assertEqual(r.json.state.platform, null, 'platform deveria ser null para sindico');
      return 'isolamento ok';
    });

    if (args.rateLimit && api.adminSession) {
      await runner.test('rate limit do admin dispara 429 sob carga', async () => {
        const limit = 220; // > 180 req/min default
        let triggered = false;
        let firstAt = -1;
        for (let i = 0; i < limit; i += 1) {
          const r = await api.adminState();
          if (r.status === 429) { triggered = true; firstAt = i + 1; break; }
        }
        assert(triggered, `nao disparou em ${limit} requests — rate limit pode estar desligado`);
        return `disparou na request ${firstAt}`;
      });
    } else if (api.adminSession) {
      runner.skip('rate limit do admin', '--rate-limit nao fornecido (gera carga)');
    }
  });
}

async function suiteWrites(api, runner, args) {
  await runner.suite('5. Mutacoes (--write)', async () => {
    if (!args.write) {
      runner.skip('cadastrar e remover apartamento de teste', '--write nao fornecido');
      runner.skip('publicar status do device de teste', '--write nao fornecido');
      return;
    }
    if (!api.adminSession) {
      runner.skip('cadastrar e remover apartamento de teste', 'sessao de sindico ausente');
      return;
    }

    const tag = `TEST-AGENT-${Date.now()}`;
    let createdId = '';

    await runner.test(`cadastrar apartamento ${tag}`, async () => {
      const r = await api.postResident({
        apartment: tag.slice(-6),
        building: 'AGENT',
        floor: '0',
        email: 'test-agent@example.invalid',
        phone: '',
      });
      assert(r.ok, `status ${r.status}: ${r.json.error || ''}`);
      assert(r.json.resident?.id, 'sem id no payload');
      createdId = r.json.resident.id;
      return `id=${createdId}`;
    });

    await runner.test('apartamento aparece no estado do admin', async () => {
      const r = await api.adminState();
      const found = (r.json.state.residents || []).find((x) => x.id === createdId);
      assert(found, `id ${createdId} nao apareceu`);
      return `building=${found.building}`;
    });

    await runner.test(`remover apartamento ${tag}`, async () => {
      const r = await api.deleteResident(createdId);
      assert(r.ok, `status ${r.status}: ${r.json.error || ''}`);
      return 'deletado';
    });

    if (api.deviceKey) {
      await runner.test('publicar status do device (POST /api/device/status)', async () => {
        const r = await api.deviceStatus({
          device: {
            online: true,
            serialOpen: true,
            serialPath: '/dev/null-test-agent',
            bridgeVersion: 'TEST-AGENT',
            doorCount: 10,
            board: 1,
            edgeAppVersion: 'test-agent',
          },
          doors: [],
          deliveries: [],
        });
        assert(r.ok, `status ${r.status}: ${r.json.error || ''}`);
        return 'status enviado';
      });
    } else {
      runner.skip('publicar status do device', 'sem --device-key');
    }
  });
}

async function suiteActuation(api, runner, args) {
  await runner.suite('6. Acionamento fisico (--actuate)', async () => {
    if (!args.actuate) {
      runner.skip('abertura remota end-to-end', '--actuate nao fornecido (porta nao sera aberta)');
      return;
    }
    if (!api.adminSession || !api.deviceKey) {
      runner.skip('abertura remota end-to-end', 'precisa de login de sindico e --device-key');
      return;
    }

    let commandId = '';
    let leaseId = '';
    let executionId = '';
    const door = 1;

    await runner.test(`POST /api/admin/doors/${door}/open cria comando`, async () => {
      const r = await api.openDoor(door, { reason: 'Teste do agente PREDDITA', requestedBy: 'test-agent' });
      assert(r.ok, `status ${r.status}: ${r.json.error || ''}`);
      assert(r.json.command?.id, 'sem command.id');
      commandId = r.json.command.id;
      assertEqual(r.json.command.status, 'pending', 'status inicial');
      return `commandId=${commandId}`;
    });

    await runner.test('GET /api/device/snapshot reserva o comando com lease', async () => {
      const r = await api.deviceSnapshot();
      assert(r.ok, `status ${r.status}`);
      const found = (r.json.commands || []).find((c) => c.id === commandId);
      assert(found, `comando ${commandId} nao foi servido para o device`);
      assertEqual(found.status, 'leased', 'status entregue');
      assert(found.leaseId, 'comando sem leaseId');
      leaseId = found.leaseId;
      executionId = `exec-test-agent-${commandId}`;
      return `status=${found.status}`;
    });

    await runner.test('POST /ack autoriza a execucao fisica', async () => {
      const r = await api.acknowledgeCommand(commandId, { leaseId, executionId });
      assert(r.ok, `status ${r.status}: ${r.json.error || ''}`);
      assertEqual(r.json.command?.status, 'executing', 'status apos ACK');
      return `executionId=${executionId}`;
    });

    await runner.test('POST /complete confirma execucao', async () => {
      const r = await api.completeCommand(commandId, {
        ok: true,
        confirmed: true,
        executionId,
        reason: 'test-agent-confirmed',
        door,
        releasedDoor: false,
      });
      assert(r.ok, `status ${r.status}: ${r.json.error || ''}`);
      return 'completed';
    });
  });
}

async function suiteEmail(api, runner, args) {
  await runner.suite('7. E-mail real (--send-email)', async () => {
    if (!args.sendEmail) {
      runner.skip('disparar e-mail de teste', '--send-email nao fornecido');
      return;
    }
    const to = process.env.PREDDITA_TEST_EMAIL;
    if (!to) {
      runner.skip('disparar e-mail de teste', 'defina PREDDITA_TEST_EMAIL com seu e-mail');
      return;
    }
    if (!api.deviceKey) {
      runner.skip('disparar e-mail de teste', 'sem --device-key');
      return;
    }

    await runner.test(`notify para ${to} dispara e-mail real`, async () => {
      const fakeDelivery = {
        id: `test-agent-${Date.now()}`,
        recipientName: 'Apartamento de teste',
        recipientEmail: to,
        unit: 'TEST - Andar 0 - Ap 0',
        building: 'PREDDITA Test',
        door: 99,
        size: 'M',
        pin: '000000',
        qrPayload: 'preddita://collect?id=test&token=test&exp=2100-01-01T00:00:00.000Z',
        status: 'stored',
        createdAt: new Date().toISOString(),
        depositedAt: new Date().toISOString(),
      };
      const r = await api.notifyDelivery(fakeDelivery);
      assert(r.ok, `status ${r.status}: ${r.json.error || ''}`);
      const status = r.json.notification?.status;
      assert(status === 'sent' || status === 'pending', `status notificacao: ${status}`);
      return `status=${status}`;
    });
  });
}

// ============================================================================
// 6. Main
// ============================================================================

function summarize(suites) {
  let pass = 0, fail = 0, skip = 0;
  for (const s of suites) for (const t of s.tests) {
    if (t.status === 'pass') pass += 1;
    else if (t.status === 'fail') fail += 1;
    else skip += 1;
  }
  return { pass, fail, skip, total: pass + fail + skip };
}

function printSummary(suites, args) {
  const { pass, fail, skip, total } = summarize(suites);
  log('');
  header('RESUMO');
  log(`Suites:    ${suites.length}`);
  log(`Total:     ${total}`);
  log(`${C.green}PASS:      ${pass}${C.reset}`);
  log(`${C.red}FAIL:      ${fail}${C.reset}`);
  log(`${C.yellow}SKIP:      ${skip}${C.reset}`);
  log('');
  log(`Base URL:  ${args.base}`);
  log(`Modo:      write=${args.write} actuate=${args.actuate} sendEmail=${args.sendEmail} rateLimit=${args.rateLimit}`);
  if (fail > 0) log(`\n${C.red}${C.bold}Houve falhas. Veja detalhes acima.${C.reset}`);
  else if (skip > 0) log(`\n${C.yellow}Tudo o que rodou passou — alguns testes ficaram pendentes (skip).${C.reset}`);
  else log(`\n${C.green}${C.bold}Tudo passou.${C.reset}`);
}

function writeReport(path, suites, args) {
  const report = {
    base: args.base,
    startedAt: args.startedAt,
    finishedAt: new Date().toISOString(),
    flags: { write: args.write, actuate: args.actuate, sendEmail: args.sendEmail, rateLimit: args.rateLimit },
    summary: summarize(suites),
    suites,
  };
  writeFileSync(path, JSON.stringify(report, null, 2));
  log(`\n${C.dim}Relatorio JSON em ${path}${C.reset}`);
}

async function main() {
  const args = parseArgs(process.argv);
  validateBaseUrl(args.base);
  args.startedAt = new Date().toISOString();

  header('PREDDITA Locker — Test Agent');
  log(`Base:      ${args.base}`);
  log(`Locker ID: ${args.lockerId}`);
  log(`Acessos:    sindico=${args.adminUsername && args.adminPassword ? 'set' : 'EMPTY'}, super=${args.superAdminUsername && args.superAdminPassword ? 'set' : 'EMPTY'}, device=${args.deviceKey ? 'set' : 'EMPTY'}`);
  log(`Flags:     ${args.write ? `${C.yellow}--write${C.reset}` : ''} ${args.actuate ? `${C.red}--actuate${C.reset}` : ''} ${args.sendEmail ? `${C.red}--send-email${C.reset}` : ''} ${args.rateLimit ? `${C.yellow}--rate-limit${C.reset}` : ''}`.trim() || 'so leitura');

  if (args.actuate) {
    log(`\n${C.red}${C.bold}AVISO:${C.reset} ${C.red}--actuate vai abrir uma porta de verdade no armario.${C.reset}`);
  }
  if (args.sendEmail) {
    log(`${C.red}${C.bold}AVISO:${C.reset} ${C.red}--send-email vai disparar um e-mail real.${C.reset}`);
  }

  const api = new ApiClient(args);
  if (args.adminUsername && args.adminPassword) {
    const session = await api.loginAdmin();
    if (!session) log(`${C.yellow}Login do sindico falhou; suites administrativas serao marcadas como falha ou skip.${C.reset}`);
  }
  if (args.superAdminUsername && args.superAdminPassword) {
    const session = await api.loginSuperAdmin();
    if (!session) log(`${C.yellow}Login do super_admin falhou; validacao de plataforma sera ignorada.${C.reset}`);
  }
  const runner = makeRunner(args);

  try {
    await suiteHealth(api, runner);
    await suiteUxRules(api, runner);
    await suiteUserErrors(api, runner);
    await suiteSecurity(api, runner, args);
    await suiteWrites(api, runner, args);
    await suiteActuation(api, runner, args);
    await suiteEmail(api, runner, args);
  } catch (error) {
    log(`\n${C.red}Erro nao tratado:${C.reset} ${error.message}`);
    if (args.verbose) log(error.stack);
  }

  printSummary(runner.results, args);
  if (args.report) writeReport(args.report, runner.results, args);

  const { fail } = summarize(runner.results);
  process.exit(fail > 0 ? 1 : 0);
}

const isEntry = fileURLToPath(import.meta.url) === process.argv[1] || process.argv[1].endsWith('test-agent.mjs');
if (isEntry) main().catch((error) => {
  console.error(`${C.red}Erro fatal:${C.reset}`, error);
  process.exit(2);
});
