/**
 * PREDDITA Locker — motor de testes embutido (modo diagnostico).
 *
 * Roda dentro do proprio armario quando o operador acessa a tela escondida.
 * Cobre 4 frentes:
 *   1. Hardware (leitura real da placa RS-485 — nao aciona destrava)
 *   2. UX entregador (fluxo de deposito puro, sem mexer em hardware)
 *   3. UX morador (resolucao de PIN/QR puro)
 *   4. Sincronia com admin online (snapshot + publish status)
 *
 * Nao chama Serial.unlock em nenhum momento — abertura fica simulada
 * via reserveDelivery/confirmDeposit puros. Sensor e firmware sao reais.
 */

import edgeAgent, {
  normalizeSensorPolarity,
  parseHexFrame,
  parseResponse,
  validateFrame,
} from './edgeAgent.js';
import {
  cancelDelivery,
  confirmDeposit,
  createDoorCatalog,
  createInitialState,
  deliveryCanBeCollected,
  findAvailableDoor,
  markDepositDoorOpened,
  reserveDelivery,
  resolvePickupRequest,
} from './lockerWorkflow.js';

const PROFILE = 'manual2025';
const HARDWARE_PROBE_LIMIT = 3; // numero de portas individuais a sondar
const REMOTE_PUBLISH_TIMEOUT_MS = 6000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: esperado ${JSON.stringify(expected)}, recebi ${JSON.stringify(actual)}`);
  }
}

function sanitizeDiagnosticDetail(value) {
  return String(value ?? '')
    .replace(/PIN=\d{6}/g, 'PIN=[simulado]')
    .replace(/([?&](?:token|key|secret|signature)=)[^&\s]+/gi, '$1[redacted]');
}

function makeRecipient() {
  return {
    id: 'diag-ap-101',
    firstName: '',
    lastName: '',
    name: 'Apartamento 101',
    cpf: '',
    unit: 'Diagnostico - Andar 1 - Ap 101',
    building: 'Diagnostico',
    floor: '1',
    apartment: '101',
    phone: '',
    email: 'diagnostico@preddita.local',
  };
}

function confirmSimulatedDeposit(reservation) {
  const baselineReadAt = '2026-07-15T12:00:00.000Z';
  const openedAt = '2026-07-15T12:00:01.000Z';
  const cycle = {
    version: 1,
    operation: 'dropoff',
    channel: reservation.delivery.door,
    sensorPolarity: 'zeroOpen',
    closedStateByte: 0x11,
    openStateByte: 0x00,
    baselineReadAt,
    openedAt,
  };
  const openedState = markDepositDoorOpened(
    reservation.state,
    reservation.delivery.id,
    cycle
  );
  return confirmDeposit(openedState, reservation.delivery.id, {}, {
    version: 1,
    channel: reservation.delivery.door,
    sensorPolarity: 'zeroOpen',
    stateByte: 0x11,
    openedAt,
    closedAt: '2026-07-15T12:00:02.000Z',
  });
}

function makeRunner(onProgress) {
  const suites = [];
  let current = null;

  function emit() {
    if (typeof onProgress === 'function') {
      onProgress({ suites: suites.map((s) => ({ ...s, tests: [...s.tests] })) });
    }
  }

  function suite(name) {
    current = { name, status: 'running', tests: [] };
    suites.push(current);
    emit();
  }

  async function test(name, fn) {
    if (!current) throw new Error(`test('${name}') chamado fora de suite()`);
    const start = Date.now();
    let outcome;
    try {
      const detail = await fn();
      outcome = {
        name,
        status: 'pass',
        detail: sanitizeDiagnosticDetail(detail),
        durationMs: Date.now() - start,
      };
    } catch (error) {
      console.error(`Diagnostic test failed: ${name}`, error);
      outcome = {
        name,
        status: 'fail',
        detail: 'Falha tecnica registrada. Consulte os logs protegidos do dispositivo.',
        durationMs: Date.now() - start,
      };
    }
    current.tests.push(outcome);
    emit();
  }

  function skip(name, reason) {
    if (!current) throw new Error(`skip('${name}') fora de suite()`);
    current.tests.push({ name, status: 'skip', detail: reason, durationMs: 0 });
    emit();
  }

  function finishSuite() {
    if (!current) return;
    current.status = current.tests.some((t) => t.status === 'fail') ? 'fail' : 'pass';
    current = null;
    emit();
  }

  return { suite, test, skip, finishSuite, getSuites: () => suites };
}

// ===========================================================================
// Suite 1: Hardware (leitura real, sem abertura)
// ===========================================================================

async function suiteHardware(runner, options) {
  runner.suite('1. Hardware (leitura real)');

  await runner.test('Serial bridge esta ativa', async () => {
    if (!edgeAgent.isNative()) {
      throw new Error('rodando em modo simulacao web — abra dentro do app no armario');
    }
    const info = edgeAgent.getHardwareInfo();
    if (!info.serialOpen) throw new Error(`serial fechada: ${info.lastSerialError || 'sem motivo'}`);
    return `path=${info.serialPath} bridge=${info.bridgeVersion}`;
  });

  await runner.test('queryFirmware da placa responde com BCC valido', async () => {
    const r = await edgeAgent.queryFirmware(options.board, PROFILE);
    if (!r.ok) throw new Error(`falhou: ${r.error}`);
    const bytes = parseHexFrame(r.hex);
    if (bytes.length < 5) throw new Error(`frame curto: ${r.hex}`);
    if (!validateFrame(bytes)) throw new Error(`BCC invalido: ${r.hex}`);
    return `bytes=${r.hex}`;
  });

  await runner.test('readAll devolve packed states de todas as portas', async () => {
    const r = await edgeAgent.readAll(options.board, PROFILE);
    if (!r.ok) throw new Error(`falhou: ${r.error}`);
    const parsed = parseResponse(r.hex, { sensorPolarity: options.sensorPolarity });
    if (!parsed) throw new Error('resposta nao parseada');
    if (parsed.type !== 'all') throw new Error(`tipo inesperado: ${parsed.type}`);
    if (!parsed.validChecksum) throw new Error('BCC invalido na resposta packed');
    if (!Array.isArray(parsed.states) || parsed.states.length === 0) {
      throw new Error('nenhum estado decodificado');
    }
    return `${parsed.states.length} canais lidos, packed=${parsed.packed}`;
  });

  await runner.test(`readStatus individual responde para portas 1..${HARDWARE_PROBE_LIMIT}`, async () => {
    const limit = Math.min(HARDWARE_PROBE_LIMIT, options.doorCount || HARDWARE_PROBE_LIMIT);
    const responses = [];
    for (let ch = 1; ch <= limit; ch += 1) {
      const r = await edgeAgent.readStatus(options.board, ch, PROFILE);
      if (r.ok) {
        const parsed = parseResponse(r.hex, { sensorPolarity: options.sensorPolarity });
        responses.push(`ch${ch}=${parsed?.state ?? parsed?.type ?? '??'}`);
      } else {
        responses.push(`ch${ch}=err(${r.error})`);
      }
    }
    if (!responses.some((line) => !line.includes('err'))) {
      throw new Error('nenhuma porta respondeu individualmente');
    }
    return responses.join(' | ');
  });

  await runner.test('Numero de portas reportado bate com config', async () => {
    const r = await edgeAgent.readAll(options.board, PROFILE);
    const parsed = r.ok
      ? parseResponse(r.hex, { sensorPolarity: options.sensorPolarity })
      : null;
    if (parsed?.type !== 'all') {
      throw new Error('readAll nao devolveu packed — nao da pra comparar');
    }
    const reported = parsed.states.length;
    if (reported < (options.doorCount || 0)) {
      throw new Error(`config diz ${options.doorCount}, placa reportou ${reported}`);
    }
    return `placa: ${reported}, config: ${options.doorCount}`;
  });

  runner.finishSuite();
}

// ===========================================================================
// Suite 2: UX entregador (puro — abertura simulada)
// ===========================================================================

async function suiteCourier(runner, options) {
  runner.suite('2. Entregador (UX simulada)');

  const recipient = makeRecipient();
  const baseState = {
    ...createInitialState(),
    recipients: [recipient],
    deliveries: [],
    deviceConfig: {
      board: options.board,
      doorCount: options.doorCount,
      sensorPolarity: options.sensorPolarity,
    },
  };
  const catalog = createDoorCatalog(options.doorCount);

  await runner.test('Catalogo tem 2 portas G na frente', () => {
    assertEq(catalog[0].size, 'G', 'porta 1');
    assertEq(catalog[1].size, 'G', 'porta 2');
    return `2G + ${catalog.length - 2}P (total ${catalog.length})`;
  });

  await runner.test('findAvailableDoor para volume G aloca porta grande', () => {
    const door = findAvailableDoor(baseState, 'G', catalog);
    assert(door, 'sem porta livre para G');
    assertEq(door.size, 'G', 'tamanho atribuido');
    return `porta ${door.channel}`;
  });

  await runner.test('findAvailableDoor para volume P prefere porta pequena', () => {
    const door = findAvailableDoor(baseState, 'P', catalog);
    assert(door, 'sem porta livre para P');
    assertEq(door.size, 'P', 'tamanho atribuido');
    return `porta ${door.channel}`;
  });

  let firstDelivery = null;
  await runner.test('reserveDelivery cria PIN de 6 digitos e QR PREDDITA', async () => {
    const result = await reserveDelivery(baseState, {
      recipientId: recipient.id,
      packageSize: 'M',
      courierName: 'Diagnostico',
      orderCode: 'DIAG-001',
      doorCatalog: catalog,
    });
    firstDelivery = result.delivery;
    assert(/^\d{6}$/.test(firstDelivery.pin), `PIN ${firstDelivery.pin} nao tem 6 digitos`);
    assert(firstDelivery.qrPayload.startsWith('preddita://collect?'), 'QR nao tem prefixo PREDDITA');
    assert(firstDelivery.qrPayload.includes(`id=${encodeURIComponent(firstDelivery.id)}`), 'QR sem id');
    assert(firstDelivery.qrPayload.includes('token='), 'QR sem token');
    assert(firstDelivery.qrPayload.includes('exp='), 'QR sem expiracao');
    return `PIN=${firstDelivery.pin} porta=${firstDelivery.door}`;
  });

  await runner.test('confirmDeposit (abertura simulada) transiciona para stored', async () => {
    if (!firstDelivery) throw new Error('reserveDelivery falhou anteriormente');
    const result = await reserveDelivery(baseState, {
      recipientId: recipient.id,
      packageSize: 'M',
      doorCatalog: catalog,
    });
    const after = confirmSimulatedDeposit(result);
    const stored = after.deliveries.find((d) => d.id === result.delivery.id);
    assertEq(stored.status, 'stored', 'status apos confirm');
    assertEq(stored.notificationStatus, 'pending', 'notificacao deveria estar pending com e-mail');
    return `status=${stored.status} notif=${stored.notificationStatus}`;
  });

  await runner.test('reserveDelivery sem volume bloqueia (UX)', async () => {
    try {
      await reserveDelivery(baseState, {
        recipientId: recipient.id,
        doorCatalog: catalog,
      });
      throw new Error('deveria ter bloqueado');
    } catch (error) {
      assert(/tamanho do volume/i.test(error.message), `mensagem inesperada: ${error.message}`);
      return error.message;
    }
  });

  await runner.test('reserveDelivery sem morador valido bloqueia (UX)', async () => {
    try {
      await reserveDelivery(baseState, {
        recipientId: 'inexistente',
        packageSize: 'M',
        doorCatalog: catalog,
      });
      throw new Error('deveria ter bloqueado');
    } catch (error) {
      assert(/apartamento/i.test(error.message), `mensagem inesperada: ${error.message}`);
      return error.message;
    }
  });

  runner.finishSuite();
}

// ===========================================================================
// Suite 3: UX morador (puro)
// ===========================================================================

async function suiteResident(runner, options) {
  runner.suite('3. Morador (UX simulada)');

  const recipient = makeRecipient();
  const baseState = {
    ...createInitialState(),
    recipients: [recipient],
    deliveries: [],
    deviceConfig: {
      board: options.board,
      doorCount: options.doorCount,
      sensorPolarity: options.sensorPolarity,
    },
  };
  const catalog = createDoorCatalog(options.doorCount);

  // monta um estado com 1 entrega armazenada
  const reserved = await reserveDelivery(baseState, {
    recipientId: recipient.id,
    packageSize: 'M',
    doorCatalog: catalog,
  });
  const stateWithStored = confirmSimulatedDeposit(reserved);

  await runner.test('PIN correto autoriza retirada', () => {
    const r = resolvePickupRequest(stateWithStored, 'pin', reserved.delivery.pin);
    assertEq(r.ok, true, 'deveria autorizar');
    assertEq(r.delivery.id, reserved.delivery.id, 'entrega devolvida');
    return `liberado para ${r.delivery.unit}`;
  });

  await runner.test('PIN errado rejeita com mensagem amigavel', () => {
    const r = resolvePickupRequest(stateWithStored, 'pin', '000000');
    assertEq(r.ok, false, 'deveria rejeitar');
    assert(r.error && /encomenda ativa|codigo/i.test(r.error), `mensagem: ${r.error}`);
    return r.error;
  });

  await runner.test('QR PREDDITA correto autoriza retirada', () => {
    const r = resolvePickupRequest(stateWithStored, 'predditaQr', reserved.delivery.qrPayload);
    assertEq(r.ok, true, 'deveria autorizar');
    return `liberado por QR para ${r.delivery.unit}`;
  });

  await runner.test('QR mal formatado rejeita', () => {
    const r = resolvePickupRequest(stateWithStored, 'predditaQr', 'http://qualquer-coisa.com');
    assertEq(r.ok, false, 'deveria rejeitar');
    return r.error;
  });

  await runner.test('Entrega cancelada nao libera porta', () => {
    const cancelled = cancelDelivery(stateWithStored, reserved.delivery.id, 'Diagnostico');
    const r = resolvePickupRequest(cancelled, 'pin', reserved.delivery.pin);
    assertEq(r.ok, false, 'cancelada deveria rejeitar');
    return r.error;
  });

  await runner.test('Entrega expirada nao pode ser coletada', () => {
    const expired = {
      ...reserved.delivery,
      status: 'stored',
      expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
    };
    assertEq(deliveryCanBeCollected(expired), false, 'expirada nao deveria coletar');
    return 'ok';
  });

  runner.finishSuite();
}

// ===========================================================================
// Suite 4: Sincronia admin (rede real)
// ===========================================================================

async function suiteRemote(runner, options) {
  runner.suite('4. Sincronia admin online');

  let snapshot = null;
  await runner.test('fetchRemoteSnapshot conecta no admin', async () => {
    snapshot = await edgeAgent.fetchRemoteSnapshot();
    if (!snapshot) {
      throw new Error('admin nao respondeu (verifique device-key, base URL e rede)');
    }
    return `${snapshot.residents?.length ?? 0} moradores, ${snapshot.commands?.length ?? 0} comandos pendentes`;
  });

  await runner.test('Snapshot traz lista de moradores', () => {
    if (!snapshot) throw new Error('snapshot anterior falhou');
    if (!Array.isArray(snapshot.residents)) {
      throw new Error('residents nao e array');
    }
    return `${snapshot.residents.length} moradores`;
  });

  await runner.test('Snapshot traz serverTime', () => {
    if (!snapshot?.serverTime) throw new Error('serverTime ausente');
    const drift = Math.abs(Date.now() - Date.parse(snapshot.serverTime));
    if (!Number.isFinite(drift)) throw new Error(`serverTime invalido: ${snapshot.serverTime}`);
    return `drift=${Math.round(drift / 1000)}s`;
  });

  await runner.test('publishRemoteStatus envia status do device', async () => {
    const info = edgeAgent.getHardwareInfo();
    const ok = await Promise.race([
      edgeAgent.publishRemoteStatus({
        device: {
          online: true,
          serialOpen: info.serialOpen,
          serialPath: info.serialPath,
          bridgeVersion: info.bridgeVersion,
          doorCount: options.doorCount,
          board: options.board,
          sensorPolarity: options.sensorPolarity,
          edgeAppVersion: 'diagnostics',
        },
        doors: [],
        deliveries: [],
      }),
      new Promise((resolve) => setTimeout(() => resolve(false), REMOTE_PUBLISH_TIMEOUT_MS)),
    ]);
    if (!ok) throw new Error('publish falhou ou timeout — admin offline?');
    return 'status enviado';
  });

  runner.finishSuite();
}

// ===========================================================================
// Entry point
// ===========================================================================

export async function runDiagnostics(options, onProgress) {
  const safeOptions = {
    board: Number.isFinite(options?.board) ? options.board : 1,
    doorCount: Number.isFinite(options?.doorCount) ? options.doorCount : 24,
    sensorPolarity: normalizeSensorPolarity(options?.sensorPolarity),
  };
  const runner = makeRunner(onProgress);

  await suiteHardware(runner, safeOptions);
  await suiteCourier(runner, safeOptions);
  await suiteResident(runner, safeOptions);
  await suiteRemote(runner, safeOptions);

  return runner.getSuites();
}

export function summarize(suites) {
  let pass = 0;
  let fail = 0;
  let skip = 0;
  for (const suite of suites) {
    for (const test of suite.tests) {
      if (test.status === 'pass') pass += 1;
      else if (test.status === 'fail') fail += 1;
      else skip += 1;
    }
  }
  return { pass, fail, skip, total: pass + fail + skip };
}
