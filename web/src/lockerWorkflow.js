import {
  DEFAULT_SENSOR_POLARITY,
  isValidDoorCloseProof,
  isValidDoorOpenCycle,
  normalizeDoorCloseProof,
  normalizeDoorOpenCycle,
  normalizeSensorPolarity,
} from './doorSafety.js';
import {
  DEFAULT_UNLOCK_TIMEOUT_SECONDS,
  buildCommissioningRecord,
  createPendingCommissioning,
  normalizeCommissioningRecord,
  normalizeDoorSizes,
  normalizeUnlockTimeoutSeconds,
} from './commissioning.js';

const STORAGE_KEY = 'preddita_entregas_locker_state_v1';
const EDGE_SECRET = 'PREDDITA-EDGE-LOCAL-2025';
const EXPIRATION_HOURS = 72;
const EVENT_LIMIT = 18;

/*
 * Regras puras do locker.
 *
 * Este arquivo nao deve conversar com serial, HTTP ou DOM. Ele concentra as
 * decisoes de negocio que precisam ser testaveis fora do Android: escolher a
 * porta correta, reservar/confirmar/cancelar entregas, validar PIN/QR e liberar
 * ocupacao. Mantenha fluxos de hardware em App.jsx/serial.js e fluxo remoto em
 * remoteBridge.js para evitar que um teste local acione uma porta real.
 */
const ACTIVE_DOOR_STATUSES = new Set([
  'door_opened_for_dropoff',
  'stored',
  'pickup_opened',
]);

const SIZE_PRIORITY = { P: 0, M: 1, G: 2 };

const DEMO_RECIPIENTS = [
  { id: 'ap-203', firstName: '', lastName: '', name: 'Apartamento 203', cpf: '', unit: 'Torre A - 2 andar - Ap 203', building: 'Torre A', floor: '2', apartment: '203', phone: '(11) 98741-2201', email: 'aline.sousa@example.com' },
  { id: 'ap-604', firstName: '', lastName: '', name: 'Apartamento 604', cpf: '', unit: 'Torre A - 6 andar - Ap 604', building: 'Torre A', floor: '6', apartment: '604', phone: '(11) 98852-4471', email: 'bruno.lima@example.com' },
  { id: 'ap-1102', firstName: '', lastName: '', name: 'Apartamento 1102', cpf: '', unit: 'Torre B - 11 andar - Ap 1102', building: 'Torre B', floor: '11', apartment: '1102', phone: '(11) 97420-1189', email: 'camila.rosa@example.com' },
  { id: 'ap-703', firstName: '', lastName: '', name: 'Apartamento 703', cpf: '', unit: 'Torre B - 7 andar - Ap 703', building: 'Torre B', floor: '7', apartment: '703', phone: '(11) 97044-5632', email: 'danilo.farias@example.com' },
  { id: 'ap-1501', firstName: '', lastName: '', name: 'Apartamento 1501', cpf: '', unit: 'Cobertura - 15 andar - Ap 1501', building: 'Cobertura', floor: '15', apartment: '1501', phone: '(11) 99318-7740', email: 'elisa.porto@example.com' },
  { id: 'ap-309', firstName: '', lastName: '', name: 'Apartamento 309', cpf: '', unit: 'Torre C - 3 andar - Ap 309', building: 'Torre C', floor: '3', apartment: '309', phone: '(11) 98127-6315', email: 'felipe.azevedo@example.com' },
];

export const PACKAGE_SIZES = [
  { id: 'P', label: 'Pequena', hint: 'Documentos, cosmeticos e caixas compactas.' },
  { id: 'M', label: 'Media', hint: 'Pacotes padrao de e-commerce.' },
  { id: 'G', label: 'Grande', hint: 'Volumes mais altos ou largos.' },
];

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function normalizePin(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function normalizeImageDataUrl(value) {
  const text = cleanText(value);
  return /^data:image\/(?:jpeg|jpg|png|webp);base64,/i.test(text) ? text : '';
}

function normalizeDeliveryEvidence(evidence = {}) {
  const confidence = Number(evidence.labelOcrConfidence);

  return {
    labelPhotoDataUrl: normalizeImageDataUrl(evidence.labelPhotoDataUrl),
    labelPhotoCapturedAt: cleanText(evidence.labelPhotoCapturedAt),
    labelOcrStatus: cleanText(evidence.labelOcrStatus),
    labelOcrText: cleanText(evidence.labelOcrText),
    labelOcrApartment: cleanText(evidence.labelOcrApartment),
    labelOcrConfidence: Number.isFinite(confidence) ? confidence : null,
    labelProofRequired: Boolean(evidence.labelProofRequired),
  };
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function extractApartmentFromUnit(unit) {
  const text = cleanText(unit);
  const explicit = text.match(/(?:ap\.?|apartamento)\s*([a-z0-9-]+)/i);
  if (explicit) return explicit[1];

  const trailing = text.match(/(?:^|[-/\s])(\d{1,6}[a-z]?)$/i);
  return trailing ? trailing[1] : '';
}

export function formatRecipientApartment(recipient = {}) {
  const apartment = cleanText(recipient.apartment) || extractApartmentFromUnit(recipient.unit);
  return apartment ? `Apartamento ${apartment}` : 'Apartamento nao informado';
}

export function formatRecipientUnit(recipient = {}) {
  const rawUnit = cleanText(recipient.unit);
  const apartment = cleanText(recipient.apartment) || extractApartmentFromUnit(rawUnit);
  const building = cleanText(recipient.building);
  const floor = cleanText(recipient.floor);
  const parts = [];

  if (building) parts.push(building);
  if (floor) parts.push(`${floor} andar`);
  if (apartment) parts.push(`Ap ${apartment}`);

  return parts.length ? parts.join(' - ') : rawUnit || 'Unidade nao informada';
}

function createId(prefix) {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createEvent(kind, message, meta = {}) {
  return { id: createId('event'), kind, message, meta, at: nowIso() };
}

function withEvent(state, kind, message, meta = {}) {
  return {
    ...state,
    auditTrail: [createEvent(kind, message, meta), ...state.auditTrail].slice(0, EVENT_LIMIT),
    updatedAt: nowIso(),
  };
}

function ensureRecipients(items) {
  if (!Array.isArray(items)) {
    return [...DEMO_RECIPIENTS];
  }

  if (items.length === 0) {
    return [];
  }

  return items.map((recipient) => {
    const unit = formatRecipientUnit(recipient);
    const apartment = cleanText(recipient.apartment) || extractApartmentFromUnit(unit);

    return {
      id: cleanText(recipient.id) || createId('recipient'),
      firstName: '',
      lastName: '',
      name: formatRecipientApartment({ ...recipient, apartment, unit }),
      cpf: '',
      unit,
      building: cleanText(recipient.building) || 'Torre A',
      floor: cleanText(recipient.floor),
      apartment,
      phone: cleanText(recipient.phone),
      email: cleanText(recipient.email),
    };
  });
}

function ensureDeliveries(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((delivery) => {
    const unit = cleanText(delivery.unit) || 'Unidade nao informada';

    return {
      id: cleanText(delivery.id) || createId('delivery'),
      recipientId: cleanText(delivery.recipientId),
      recipientName: formatRecipientApartment({ unit }),
      recipientCpf: '',
      recipientEmail: cleanText(delivery.recipientEmail),
      unit,
      building: cleanText(delivery.building) || 'Empreendimento nao informado',
      courierName: cleanText(delivery.courierName) || 'Entregador',
      orderCode: cleanText(delivery.orderCode) || 'Sem referencia',
      externalCode: cleanText(delivery.externalCode),
      notes: cleanText(delivery.notes),
      size: ['P', 'M', 'G'].includes(delivery.size) ? delivery.size : 'M',
      door: clampNumber(delivery.door, 1, 24, 1),
      doorSize: ['P', 'M', 'G'].includes(delivery.doorSize) ? delivery.doorSize : 'M',
      pin: normalizePin(delivery.pin),
      token: cleanText(delivery.token),
      qrPayload: cleanText(delivery.qrPayload),
      status: cleanText(delivery.status) || 'stored',
      notificationStatus: cleanText(delivery.notificationStatus),
      notificationRequestedAt: cleanText(delivery.notificationRequestedAt),
      notificationSentAt: cleanText(delivery.notificationSentAt),
      notificationError: cleanText(delivery.notificationError),
      notificationMessageId: cleanText(delivery.notificationMessageId),
      createdAt: cleanText(delivery.createdAt) || nowIso(),
      depositedAt: cleanText(delivery.depositedAt),
      pickupOpenedAt: cleanText(delivery.pickupOpenedAt),
      collectedAt: cleanText(delivery.collectedAt),
      cancelledAt: cleanText(delivery.cancelledAt),
      cancelReason: cleanText(delivery.cancelReason),
      expiresAt: cleanText(delivery.expiresAt),
      dropoffDoorCycle: isValidDoorOpenCycle(delivery.dropoffDoorCycle, {
        channel: delivery.door,
        operation: 'dropoff',
      }) ? normalizeDoorOpenCycle(delivery.dropoffDoorCycle) : null,
      dropoffCloseProof: isValidDoorCloseProof(delivery.dropoffDoorCycle, delivery.dropoffCloseProof)
        ? normalizeDoorCloseProof(delivery.dropoffCloseProof)
        : null,
      pickupDoorCycle: isValidDoorOpenCycle(delivery.pickupDoorCycle, {
        channel: delivery.door,
      }) ? normalizeDoorOpenCycle(delivery.pickupDoorCycle) : null,
      pickupCloseProof: isValidDoorCloseProof(delivery.pickupDoorCycle, delivery.pickupCloseProof)
        ? normalizeDoorCloseProof(delivery.pickupCloseProof)
        : null,
      pickupSource: cleanText(delivery.pickupSource),
      ...normalizeDeliveryEvidence(delivery),
      reminderLevel: clampNumber(delivery.reminderLevel, 0, 3, 0),
      reminderLastQueuedAt: cleanText(delivery.reminderLastQueuedAt),
      reminderLastSentAt: cleanText(delivery.reminderLastSentAt),
      reminderError: cleanText(delivery.reminderError),
    };
  });
}

function ensureAuditTrail(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return [createEvent('boot', 'Locker inicializado em modo local para deposito e retirada.')];
  }

  return items
    .map((entry) => ({
      id: cleanText(entry.id) || createId('event'),
      kind: cleanText(entry.kind) || 'info',
      message: cleanText(entry.message) || 'Evento sem descricao.',
      meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : {},
      at: cleanText(entry.at) || nowIso(),
    }))
    .slice(0, EVENT_LIMIT);
}

export function createDoorCatalog(doorCount = 24, configuredSizes = []) {
  const safeCount = clampNumber(doorCount, 1, 24, 24);
  const doorSizes = normalizeDoorSizes(configuredSizes, safeCount);

  return Array.from({ length: safeCount }, (_, index) => {
    const channel = index + 1;
    const size = doorSizes[index];

    return { channel, size, label: `Porta ${channel}` };
  });
}

export function createInitialState() {
  const doorCount = 24;
  const doorSizes = normalizeDoorSizes([], doorCount);
  const deviceConfig = {
    board: 1,
    doorCount,
    sensorPolarity: DEFAULT_SENSOR_POLARITY,
    unlockTimeoutSeconds: DEFAULT_UNLOCK_TIMEOUT_SECONDS,
    doorSizes,
  };

  return {
    tenant: {
      id: 'tenant-demo',
      name: 'PREDDITA Entregas Locker',
      siteName: 'Residencial Aurora',
      deviceLabel: 'Locker Entregas Torre Norte',
    },
    deviceConfig: {
      ...deviceConfig,
      commissioning: createPendingCommissioning(deviceConfig),
    },
    recipients: [...DEMO_RECIPIENTS],
    remoteResidentsRevision: '',
    residentsSyncedAt: '',
    deliveries: [],
    auditTrail: [createEvent('boot', 'Locker inicializado em modo local para deposito e retirada.')],
    updatedAt: nowIso(),
  };
}

export function loadLockerState() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return createInitialState();
  }

  try {
    const rawValue = window.localStorage.getItem(STORAGE_KEY);
    if (!rawValue) {
      return createInitialState();
    }

    const parsed = JSON.parse(rawValue);
    const fallback = createInitialState();
    const board = clampNumber(parsed?.deviceConfig?.board, 1, 31, 1);
    const doorCount = clampNumber(parsed?.deviceConfig?.doorCount, 1, 24, 24);
    const sensorPolarity = normalizeSensorPolarity(parsed?.deviceConfig?.sensorPolarity);
    const unlockTimeoutSeconds = normalizeUnlockTimeoutSeconds(
      parsed?.deviceConfig?.unlockTimeoutSeconds
    );
    const doorSizes = normalizeDoorSizes(parsed?.deviceConfig?.doorSizes, doorCount);
    const deviceConfig = {
      board,
      doorCount,
      sensorPolarity,
      unlockTimeoutSeconds,
      doorSizes,
    };

    return {
      tenant: parsed.tenant && typeof parsed.tenant === 'object' ? { ...fallback.tenant, ...parsed.tenant } : fallback.tenant,
      deviceConfig: {
        ...deviceConfig,
        commissioning: normalizeCommissioningRecord(
          parsed?.deviceConfig?.commissioning,
          deviceConfig,
        ),
      },
      recipients: ensureRecipients(parsed.recipients),
      remoteResidentsRevision: cleanText(parsed.remoteResidentsRevision),
      residentsSyncedAt: cleanText(parsed.residentsSyncedAt),
      deliveries: ensureDeliveries(parsed.deliveries),
      auditTrail: ensureAuditTrail(parsed.auditTrail),
      updatedAt: cleanText(parsed.updatedAt) || fallback.updatedAt,
    };
  } catch (_error) {
    return createInitialState();
  }
}

export function persistLockerState(state) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (_error) {
  }
}

export function updateDeviceConfig(state, updates) {
  const board = clampNumber(updates?.board ?? state.deviceConfig.board, 1, 31, state.deviceConfig.board);
  const doorCount = clampNumber(updates?.doorCount ?? state.deviceConfig.doorCount, 1, 24, state.deviceConfig.doorCount);
  const sensorPolarity = normalizeSensorPolarity(
    updates?.sensorPolarity ?? state.deviceConfig.sensorPolarity
  );
  const unlockTimeoutSeconds = normalizeUnlockTimeoutSeconds(
    updates?.unlockTimeoutSeconds ?? state.deviceConfig.unlockTimeoutSeconds
  );
  const doorSizes = normalizeDoorSizes(
    updates?.doorSizes ?? state.deviceConfig.doorSizes,
    doorCount,
  );
  const nextDeviceConfig = {
    board,
    doorCount,
    sensorPolarity,
    unlockTimeoutSeconds,
    doorSizes,
  };
  const currentDoorSizes = normalizeDoorSizes(state.deviceConfig.doorSizes, state.deviceConfig.doorCount);
  const configurationChanged =
    board !== state.deviceConfig.board ||
    doorCount !== state.deviceConfig.doorCount ||
    sensorPolarity !== normalizeSensorPolarity(state.deviceConfig.sensorPolarity) ||
    unlockTimeoutSeconds !== normalizeUnlockTimeoutSeconds(state.deviceConfig.unlockTimeoutSeconds) ||
    doorSizes.some((size, index) => size !== currentDoorSizes[index]);
  const commissioning = configurationChanged
    ? createPendingCommissioning(nextDeviceConfig)
    : normalizeCommissioningRecord(state.deviceConfig.commissioning, nextDeviceConfig);

  return withEvent(
    {
      ...state,
      deviceConfig: { ...nextDeviceConfig, commissioning },
    },
    'config',
    `Configuracao aplicada: board ${board} com ${doorCount} portas.`,
    { board, doorCount, sensorPolarity, unlockTimeoutSeconds }
  );
}

export function applyDeviceCommissioning(state, payload = {}) {
  const board = clampNumber(payload.board, 1, 31, state.deviceConfig.board);
  const doorCount = clampNumber(payload.doorCount, 1, 24, state.deviceConfig.doorCount);
  const sensorPolarity = normalizeSensorPolarity(payload.sensorPolarity);
  const unlockTimeoutSeconds = normalizeUnlockTimeoutSeconds(payload.unlockTimeoutSeconds);
  const doorSizes = normalizeDoorSizes(payload.doorSizes, doorCount);
  const commissioning = buildCommissioningRecord({
    ...payload,
    board,
    doorCount,
    sensorPolarity,
    unlockTimeoutSeconds,
    doorSizes,
  });

  return withEvent(
    {
      ...state,
      deviceConfig: {
        board,
        doorCount,
        sensorPolarity,
        unlockTimeoutSeconds,
        doorSizes,
        commissioning,
      },
    },
    'commissioning-complete',
    `Comissionamento concluido: ${doorCount} portas validadas no board ${board}.`,
    {
      board,
      doorCount,
      sensorPolarity,
      unlockTimeoutSeconds,
      completedAt: commissioning.completedAt,
    },
  );
}

export function isDeliveryExpired(delivery) {
  if (!delivery?.expiresAt) {
    return false;
  }
  const expiration = Date.parse(delivery.expiresAt);
  return Number.isFinite(expiration) ? expiration < Date.now() : false;
}

export function deliveryCanBeCollected(delivery) {
  return !!delivery && !isDeliveryExpired(delivery) && (delivery.status === 'stored' || delivery.status === 'pickup_opened');
}

export function countActiveDeliveries(deliveries) {
  return deliveries.filter((delivery) => ACTIVE_DOOR_STATUSES.has(delivery.status)).length;
}

export function getDoorOccupancyMap(deliveries) {
  return deliveries.reduce((accumulator, delivery) => {
    if (ACTIVE_DOOR_STATUSES.has(delivery.status)) {
      accumulator[delivery.door] = delivery;
    }
    return accumulator;
  }, {});
}

export function getDeliveryStatusLabel(delivery) {
  if (!delivery) {
    return 'Livre';
  }
  if (delivery.status === 'door_opened_for_dropoff') {
    return 'Aguardando deposito';
  }
  if (delivery.status === 'stored') {
    return isDeliveryExpired(delivery) ? 'Expirada' : 'Pronta para retirada';
  }
  if (delivery.status === 'pickup_opened') {
    return 'Retirada em andamento';
  }
  if (delivery.status === 'collected') {
    return 'Retirada concluida';
  }
  if (delivery.status === 'cancelled') {
    return 'Cancelada';
  }
  return delivery.status;
}

export function findAvailableDoor(state, requestedSize = 'M', doorCatalog = []) {
  const occupancy = getDoorOccupancyMap(state.deliveries);
  const safeSize = ['P', 'M', 'G'].includes(requestedSize) ? requestedSize : 'M';
  const requestedLevel = SIZE_PRIORITY[safeSize];

  return (
    doorCatalog
      .filter((door) => SIZE_PRIORITY[door.size] >= requestedLevel)
      .sort((left, right) => {
        const sizeGap = SIZE_PRIORITY[left.size] - SIZE_PRIORITY[right.size];
        return sizeGap !== 0 ? sizeGap : left.channel - right.channel;
      })
      .find((door) => !occupancy[door.channel]) ?? null
  );
}

function createPickupPin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

async function signPayload(payload) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  }

  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(EDGE_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return bytesToHex(new Uint8Array(signature)).slice(0, 24).toUpperCase();
}

function buildCollectQr(deliveryId, token, expiresAt) {
  return `preddita://collect?id=${encodeURIComponent(deliveryId)}&token=${encodeURIComponent(token)}&exp=${encodeURIComponent(expiresAt)}`;
}

export async function reserveDelivery(state, payload) {
  const recipient = state.recipients.find((entry) => entry.id === payload.recipientId);
  if (!recipient) {
    throw new Error('Selecione um apartamento valido antes de abrir a porta.');
  }

  const size = cleanText(payload.packageSize).toUpperCase();
  if (!['P', 'M', 'G'].includes(size)) {
    throw new Error('Escolha o tamanho do volume antes de abrir a porta.');
  }

  const catalog = Array.isArray(payload.doorCatalog) && payload.doorCatalog.length > 0
    ? payload.doorCatalog
    : createDoorCatalog(state.deviceConfig.doorCount, state.deviceConfig.doorSizes);
  const assignedDoor = findAvailableDoor(state, size, catalog);

  if (!assignedDoor) {
    throw new Error(`Nao ha compartimentos livres compativeis com o volume ${size}.`);
  }

  const id = createId('delivery');
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + EXPIRATION_HOURS * 60 * 60 * 1000).toISOString();
  const courierName = cleanText(payload.courierName) || 'Entregador';
  const orderCode = cleanText(payload.orderCode) || 'Sem referencia';
  const externalCode = cleanText(payload.externalCode);
  const notes = cleanText(payload.notes);
  const pin = createPickupPin();
  const recipientDisplay = formatRecipientApartment(recipient);
  const unit = formatRecipientUnit(recipient);
  const token = await signPayload([id, recipient.id, assignedDoor.channel, orderCode, expiresAt, externalCode].join('|'));
  const qrPayload = buildCollectQr(id, token, expiresAt);

  const delivery = {
    id,
    recipientId: recipient.id,
    recipientName: recipientDisplay,
    recipientCpf: '',
    recipientEmail: recipient.email,
    unit,
    building: recipient.building,
    courierName,
    orderCode,
    externalCode,
    notes,
    size,
    door: assignedDoor.channel,
    doorSize: assignedDoor.size,
    pin,
    token,
    qrPayload,
    status: 'door_opened_for_dropoff',
    notificationStatus: '',
    notificationRequestedAt: '',
    notificationSentAt: '',
    notificationError: '',
    notificationMessageId: '',
    createdAt,
    depositedAt: '',
    pickupOpenedAt: '',
    collectedAt: '',
    cancelledAt: '',
    cancelReason: '',
    expiresAt,
    dropoffDoorCycle: null,
    dropoffCloseProof: null,
    pickupDoorCycle: null,
    pickupCloseProof: null,
    pickupSource: '',
    ...normalizeDeliveryEvidence(),
    reminderLevel: 0,
    reminderLastQueuedAt: '',
    reminderLastSentAt: '',
    reminderError: '',
  };

  const nextState = withEvent(
    {
      ...state,
      deliveries: [delivery, ...state.deliveries],
    },
    'deposit-created',
    `Compartimento ${delivery.door} reservado para ${delivery.unit}.`,
    { deliveryId: delivery.id, door: delivery.door }
  );

  return { state: nextState, delivery };
}

export function markDepositDoorOpened(state, deliveryId, cycle) {
  const target = state.deliveries.find((delivery) => delivery.id === deliveryId);
  if (!target) return state;
  if (target.status !== 'door_opened_for_dropoff') {
    throw new Error('A entrega nao esta aguardando deposito.');
  }
  if (!isValidDoorOpenCycle(cycle, { channel: target.door, operation: 'dropoff' })) {
    throw new Error('A abertura fisica da porta nao foi confirmada pelo sensor.');
  }

  return withEvent(
    {
      ...state,
      deliveries: state.deliveries.map((delivery) =>
        delivery.id === deliveryId
          ? { ...delivery, dropoffDoorCycle: normalizeDoorOpenCycle(cycle) }
          : delivery
      ),
    },
    'dropoff-door-opened',
    `Abertura fisica confirmada na porta ${target.door}.`,
    { deliveryId, door: target.door }
  );
}

export function confirmDeposit(state, deliveryId, evidence = {}, closeProof = null) {
  const target = state.deliveries.find((delivery) => delivery.id === deliveryId);
  if (!target) {
    return state;
  }
  if (target.status !== 'door_opened_for_dropoff') {
    throw new Error('A entrega nao esta aguardando confirmacao de deposito.');
  }
  if (!isValidDoorOpenCycle(target.dropoffDoorCycle, {
    channel: target.door,
    operation: 'dropoff',
  })) {
    throw new Error('A abertura fisica da porta nao foi registrada.');
  }
  if (!isValidDoorCloseProof(target.dropoffDoorCycle, closeProof)) {
    throw new Error('O fechamento fisico da porta nao foi confirmado pelo sensor.');
  }

  const normalizedEvidence = normalizeDeliveryEvidence(evidence);

  return withEvent(
    {
      ...state,
      deliveries: state.deliveries.map((delivery) =>
        delivery.id === deliveryId
          ? {
              ...delivery,
              status: 'stored',
              depositedAt: delivery.depositedAt || normalizeDoorCloseProof(closeProof).closedAt,
              notificationStatus: delivery.recipientEmail ? 'pending' : 'skipped',
              notificationRequestedAt: delivery.notificationRequestedAt || nowIso(),
              notificationError: delivery.recipientEmail ? '' : 'Apartamento sem e-mail cadastrado.',
              dropoffCloseProof: normalizeDoorCloseProof(closeProof),
              ...normalizedEvidence,
            }
          : delivery
      ),
    },
    'deposit-confirmed',
    `Entrega armazenada para ${target.unit} na porta ${target.door}.`,
    { deliveryId, door: target.door }
  );
}

export function markDeliveryNotification(state, deliveryId, notification = {}) {
  const target = state.deliveries.find((delivery) => delivery.id === deliveryId);
  if (!target) {
    return state;
  }

  const status = cleanText(notification.status || notification.notificationStatus || target.notificationStatus);

  return {
    ...state,
    deliveries: state.deliveries.map((delivery) =>
      delivery.id === deliveryId
        ? {
            ...delivery,
            notificationStatus: status,
            notificationRequestedAt: cleanText(notification.requestedAt || notification.notificationRequestedAt || delivery.notificationRequestedAt),
            notificationSentAt: cleanText(notification.sentAt || notification.notificationSentAt || delivery.notificationSentAt),
            notificationError: cleanText(notification.error || notification.notificationError),
            notificationMessageId: cleanText(notification.messageId || notification.notificationMessageId || delivery.notificationMessageId),
          }
        : delivery
    ),
  };
}

export function cancelDelivery(state, deliveryId, reason = 'Reserva cancelada.') {
  const target = state.deliveries.find((delivery) => delivery.id === deliveryId);
  if (!target) {
    return state;
  }

  return withEvent(
    {
      ...state,
      deliveries: state.deliveries.map((delivery) =>
        delivery.id === deliveryId
          ? {
              ...delivery,
              status: 'cancelled',
              cancelledAt: nowIso(),
              cancelReason: cleanText(reason) || 'Reserva cancelada.',
            }
          : delivery
      ),
    },
    'deposit-cancelled',
    `Reserva da porta ${target.door} cancelada.`,
    { deliveryId, door: target.door, reason: cleanText(reason) || 'Reserva cancelada.' }
  );
}

function parseCollectQr(rawValue) {
  const value = cleanText(rawValue);
  if (!value.startsWith('preddita://collect?')) {
    return null;
  }

  const query = value.split('?')[1] ?? '';
  const searchParams = new URLSearchParams(query);
  const id = cleanText(searchParams.get('id'));
  const token = cleanText(searchParams.get('token'));
  const exp = cleanText(searchParams.get('exp'));

  return id && token ? { id, token, exp } : null;
}

export function resolvePickupRequest(state, mode, rawValue) {
  const value = cleanText(rawValue);
  if (!value) {
    return { ok: false, error: 'Informe um PIN, QR PREDDITA ou QR externo para continuar.' };
  }

  let delivery = null;

  if (mode === 'pin') {
    const normalizedPin = normalizePin(value);
    delivery = state.deliveries.find(
      (item) => item.pin === normalizedPin && deliveryCanBeCollected(item)
    );
  } else if (mode === 'predditaQr') {
    const parsed = parseCollectQr(value);
    if (!parsed) {
      return { ok: false, error: 'O QR informado nao segue o formato PREDDITA.' };
    }

    delivery = state.deliveries.find(
      (item) => item.id === parsed.id && item.token === parsed.token && deliveryCanBeCollected(item)
    );

    if (delivery && parsed.exp && delivery.expiresAt !== parsed.exp) {
      return { ok: false, error: 'O QR informado nao corresponde ao token ativo desta entrega.' };
    }
  } else if (mode === 'externalQr') {
    delivery = state.deliveries.find(
      (item) => cleanText(item.externalCode) === value && deliveryCanBeCollected(item)
    );
  }

  if (!delivery) {
    return {
      ok: false,
      error:
        mode === 'externalQr'
          ? 'Nao encontramos um mapeamento ativo para este QR externo.'
          : 'Nao existe uma encomenda ativa compativel com este codigo.',
    };
  }

  if (isDeliveryExpired(delivery)) {
    return { ok: false, error: 'O codigo de retirada expirou e precisa ser renovado.' };
  }

  return { ok: true, delivery };
}

export function markPickupDoorOpened(state, deliveryId, cycle, options = {}) {
  const target = state.deliveries.find((delivery) => delivery.id === deliveryId);
  if (!target) {
    return state;
  }
  if (!['stored', 'pickup_opened'].includes(target.status)) {
    throw new Error('A entrega nao esta disponivel para retirada.');
  }
  if (!isValidDoorOpenCycle(cycle, { channel: target.door })) {
    throw new Error('A abertura fisica da porta nao foi confirmada pelo sensor.');
  }

  return withEvent(
    {
      ...state,
      deliveries: state.deliveries.map((delivery) =>
        delivery.id === deliveryId
          ? {
              ...delivery,
              status: 'pickup_opened',
              pickupOpenedAt: normalizeDoorOpenCycle(cycle).openedAt,
              pickupDoorCycle: normalizeDoorOpenCycle(cycle),
              pickupCloseProof: null,
              pickupSource: cleanText(options.source) || 'local',
            }
          : delivery
      ),
    },
    'pickup-opened',
    `Porta ${target.door} liberada para ${target.unit}.`,
    { deliveryId, door: target.door }
  );
}

export function completePickup(state, deliveryId, closeProof = null) {
  const target = state.deliveries.find((delivery) => delivery.id === deliveryId);
  if (!target) {
    return state;
  }
  if (target.status !== 'pickup_opened') {
    throw new Error('A retirada nao esta aguardando fechamento da porta.');
  }
  if (!isValidDoorOpenCycle(target.pickupDoorCycle, { channel: target.door })) {
    throw new Error('A abertura fisica da retirada nao foi registrada.');
  }
  if (!isValidDoorCloseProof(target.pickupDoorCycle, closeProof)) {
    throw new Error('O fechamento fisico da porta nao foi confirmado pelo sensor.');
  }

  return withEvent(
    {
      ...state,
      deliveries: state.deliveries.map((delivery) =>
        delivery.id === deliveryId
          ? {
              ...delivery,
              status: 'collected',
              collectedAt: normalizeDoorCloseProof(closeProof).closedAt,
              pickupCloseProof: normalizeDoorCloseProof(closeProof),
            }
          : delivery
      ),
    },
    'pickup-complete',
    `Retirada concluida para ${target.unit} na porta ${target.door}.`,
    { deliveryId, door: target.door }
  );
}

export function releaseDoorOccupancy(state, door, source = 'admin', closeProof = null) {
  const safeDoor = clampNumber(door, 1, 24, 0);
  const target = state.deliveries.find(
    (delivery) => delivery.door === safeDoor && ACTIVE_DOOR_STATUSES.has(delivery.status)
  );

  if (!target) {
    return state;
  }

  const isUnfinishedDeposit = target.status === 'door_opened_for_dropoff';
  const nextDelivery = isUnfinishedDeposit
    ? {
        ...target,
        status: 'cancelled',
        cancelledAt: nowIso(),
        cancelReason: source === 'remote-admin'
          ? 'Porta liberada por abertura remota do administrador.'
          : 'Porta liberada antes da confirmacao de deposito.',
      }
    : null;

  if (!isUnfinishedDeposit) {
    return completePickup(state, target.id, closeProof);
  }

  return withEvent(
    {
      ...state,
      deliveries: state.deliveries.map((delivery) =>
        delivery.id === target.id ? nextDelivery : delivery
      ),
    },
    source === 'remote-admin' ? 'admin-door-released' : 'pickup-complete',
    source === 'remote-admin'
      ? `Porta ${target.door} liberada pelo administrador.`
      : `Retirada concluida para ${target.unit} na porta ${target.door}.`,
    { deliveryId: target.id, door: target.door, source }
  );
}

export function buildNotificationPreview(delivery) {
  if (!delivery) {
    return '';
  }

  return [
    `Ola, sua encomenda esta pronta no ${delivery.building}.`,
    `Unidade: ${delivery.unit}`,
    `Porta: ${delivery.door}`,
    `PIN: ${delivery.pin}`,
    `QR PREDDITA: ${delivery.qrPayload}`,
    delivery.externalCode ? `QR externo vinculado: ${delivery.externalCode}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
}
