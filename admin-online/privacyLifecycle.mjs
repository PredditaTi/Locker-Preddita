export const PRIVACY_SCHEMA_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_DELIVERY_STATUSES = new Set(['door_opened_for_dropoff', 'stored', 'pickup_opened']);
const TERMINAL_DELIVERY_STATUSES = new Set(['collected', 'cancelled', 'expired']);
const TERMINAL_COMMAND_STATUSES = new Set(['completed', 'failed']);
const DELIVERY_SECRET_FIELDS = ['pin', 'token', 'qrPayload', 'externalCode'];
const DELIVERY_PERSONAL_FIELDS = [
  'recipientId', 'recipientName', 'recipientEmail', 'recipientPhone', 'recipientCpf',
  'firstName', 'lastName', 'name', 'email', 'phone', 'cpf', 'unit',
  'apartment', 'building', 'floor', 'courierName', 'orderCode', 'notes',
  'cancelReason', 'notificationError', 'notificationMessageId', 'reminderError',
];
const DELIVERY_EVIDENCE_FIELDS = [
  'labelPhotoDataUrl', 'labelOcrText', 'labelOcrApartment',
];
const BLOCKED_AUDIT_KEY = /(?:authorization|cookie|csrf|password|passwd|secret|token|signature|devicekey|pin|cpf|email|phone|recovery|totp|mfa|dataurl|photo|evidence|payload|recipientname|unit|apartment|notes)/i;

function cleanText(value) {
  return String(value ?? '').trim();
}

function retentionDays(value, fallback, maximum = 3650) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function isoNow(nowMs) {
  return new Date(nowMs).toISOString();
}

function timestamp(value) {
  const parsed = Date.parse(cleanText(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function isOlderThan(value, days, nowMs) {
  const parsed = timestamp(value);
  return parsed !== null && nowMs - parsed >= days * DAY_MS;
}

function terminalDeliveryReference(delivery = {}) {
  const status = cleanText(delivery.status);
  if (status === 'collected') return delivery.collectedAt || delivery.pickupOpenedAt || delivery.depositedAt || delivery.createdAt;
  if (status === 'cancelled') return delivery.cancelledAt || delivery.createdAt;
  if (status === 'expired') return delivery.expiresAt || delivery.depositedAt || delivery.createdAt;
  return '';
}

function commandReference(command = {}) {
  return command.completedAt || command.acknowledgedAt || command.createdAt;
}

function outboxReference(item = {}) {
  return item.sentAt || item.lastAttemptAt || item.requestedAt;
}

function hasTextField(source, fields) {
  return fields.some((field) => cleanText(source?.[field]));
}

function isTerminalDelivery(delivery = {}) {
  return TERMINAL_DELIVERY_STATUSES.has(cleanText(delivery.status));
}

function isActiveDelivery(delivery = {}) {
  return ACTIVE_DELIVERY_STATUSES.has(cleanText(delivery.status));
}

export function normalizePrivacyConfig(env = {}) {
  return Object.freeze({
    schemaVersion: PRIVACY_SCHEMA_VERSION,
    controllerName: cleanText(env.PREDDITA_PRIVACY_CONTROLLER_NAME),
    contactEmail: cleanText(env.PREDDITA_PRIVACY_CONTACT_EMAIL).toLowerCase(),
    deliveryEvidenceRetentionDays: retentionDays(env.PREDDITA_DELIVERY_EVIDENCE_RETENTION_DAYS, 30),
    deliveryPersonalDataRetentionDays: retentionDays(env.PREDDITA_DELIVERY_PERSONAL_DATA_RETENTION_DAYS, 90),
    deliveryRecordRetentionDays: retentionDays(env.PREDDITA_DELIVERY_RECORD_RETENTION_DAYS, 730, 7300),
    auditRetentionDays: retentionDays(env.PREDDITA_AUDIT_RETENTION_DAYS, 365, 7300),
    commandRetentionDays: retentionDays(env.PREDDITA_COMMAND_RETENTION_DAYS, 365, 7300),
    notificationRetentionDays: retentionDays(env.PREDDITA_NOTIFICATION_RETENTION_DAYS, 30),
    processedEventRetentionDays: retentionDays(env.PREDDITA_PROCESSED_EVENT_RETENTION_DAYS, 365, 7300),
    backupRetentionDays: retentionDays(env.PREDDITA_BACKUP_RETENTION_DAYS, 7, 365),
    operationalLogRetentionDays: retentionDays(env.PREDDITA_OPERATIONAL_LOG_RETENTION_DAYS, 30),
  });
}

export function sanitizeAuditMessage(value) {
  return cleanText(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[dado protegido]')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[dado protegido]')
    .replace(/(?:\+?55\s*)?\(?\d{2}\)?\s*\d{4,5}-?\d{4}\b/g, '[dado protegido]')
    .replace(/\bPIN\s*[:#-]?\s*\d{4,12}\b/gi, 'PIN [dado protegido]')
    .replace(/\b(token|secret|password|senha|recovery code|codigo de recuperacao)\s*[:#=-]?\s*[^\s,;.]+/gi, '$1 [dado protegido]')
    .replace(/([?&](?:token|code)=)[^&\s]+/gi, '$1[dado protegido]');
}

function sanitizeAuditValue(value, key = '', depth = 0) {
  if (BLOCKED_AUDIT_KEY.test(key)) return '[dado protegido]';
  if (depth >= 4) return '[contexto limitado]';
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => sanitizeAuditValue(item, key, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 60)
        .map(([childKey, childValue]) => [childKey, sanitizeAuditValue(childValue, childKey, depth + 1)])
    );
  }
  if (typeof value === 'string') return sanitizeAuditMessage(value).slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  return cleanText(value).slice(0, 500);
}

export function sanitizeAuditMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  return sanitizeAuditValue(meta);
}

export function hasDeliveryCredentials(delivery = {}) {
  return hasTextField(delivery, DELIVERY_SECRET_FIELDS);
}

export function hasDeliveryPersonalData(delivery = {}) {
  return hasTextField(delivery, DELIVERY_PERSONAL_FIELDS);
}

export function hasDeliveryEvidence(delivery = {}) {
  return hasTextField(delivery, DELIVERY_EVIDENCE_FIELDS)
    || (
      delivery.labelOcrConfidence !== null
      && delivery.labelOcrConfidence !== ''
      && Number.isFinite(Number(delivery.labelOcrConfidence))
    );
}

export function eraseTerminalDeliveryCredentials(delivery = {}, erasedAt = new Date().toISOString()) {
  if (!isTerminalDelivery(delivery)) return delivery;
  return eraseDeliveryCredentials(delivery, erasedAt);
}

function eraseDeliveryCredentials(delivery = {}, erasedAt = new Date().toISOString()) {
  if (!hasDeliveryCredentials(delivery)) return delivery;
  return {
    ...delivery,
    pin: '',
    token: '',
    qrPayload: '',
    externalCode: '',
    credentialsErasedAt: cleanText(delivery.credentialsErasedAt) || erasedAt,
  };
}

export function eraseDeliveryEvidence(delivery = {}, erasedAt = new Date().toISOString()) {
  if (!hasDeliveryEvidence(delivery)) return delivery;
  return {
    ...delivery,
    labelPhotoDataUrl: '',
    labelOcrStatus: 'erased-by-retention',
    labelOcrText: '',
    labelOcrApartment: '',
    labelOcrConfidence: null,
    labelProofRequired: false,
    evidenceErasedAt: cleanText(delivery.evidenceErasedAt) || erasedAt,
  };
}

export function anonymizeDelivery(delivery = {}, anonymizedAt = new Date().toISOString()) {
  let next = eraseDeliveryCredentials(delivery, anonymizedAt);
  next = eraseDeliveryEvidence(next, anonymizedAt);
  if (!hasDeliveryPersonalData(next) && cleanText(next.personalDataAnonymizedAt)) return next;
  return {
    ...next,
    recipientId: '',
    recipientName: '',
    recipientEmail: '',
    recipientPhone: '',
    recipientCpf: '',
    firstName: '',
    lastName: '',
    name: '',
    email: '',
    phone: '',
    cpf: '',
    unit: '',
    apartment: '',
    building: '',
    floor: '',
    courierName: '',
    orderCode: '',
    notes: '',
    cancelReason: '',
    notificationError: '',
    notificationMessageId: '',
    reminderError: '',
    personalDataAnonymizedAt: cleanText(next.personalDataAnonymizedAt) || anonymizedAt,
  };
}

function privacyPolicy(config) {
  return {
    schemaVersion: config.schemaVersion,
    controllerName: config.controllerName,
    contactEmail: config.contactEmail,
    terminalCredentialRetention: 'immediate',
    deliveryEvidenceRetentionDays: config.deliveryEvidenceRetentionDays,
    deliveryPersonalDataRetentionDays: config.deliveryPersonalDataRetentionDays,
    deliveryRecordRetentionDays: config.deliveryRecordRetentionDays,
    auditRetentionDays: config.auditRetentionDays,
    commandRetentionDays: config.commandRetentionDays,
    notificationRetentionDays: config.notificationRetentionDays,
    processedEventRetentionDays: config.processedEventRetentionDays,
    backupRetentionDays: config.backupRetentionDays,
    operationalLogRetentionDays: config.operationalLogRetentionDays,
  };
}

function privacyMetrics(state, config, nowMs) {
  const deliveries = Array.isArray(state.deliveries) ? state.deliveries : [];
  const auditTrail = Array.isArray(state.auditTrail) ? state.auditTrail : [];
  const commands = Array.isArray(state.commands) ? state.commands : [];
  const outbox = Array.isArray(state.notificationOutbox) ? state.notificationOutbox : [];
  const processedEvents = Array.isArray(state.processedDeviceEvents) ? state.processedDeviceEvents : [];
  return {
    residentCount: Array.isArray(state.residents) ? state.residents.length : 0,
    activeDeliveryCount: deliveries.filter(isActiveDelivery).length,
    terminalDeliveryCount: deliveries.filter(isTerminalDelivery).length,
    anonymizedDeliveryCount: deliveries.filter((item) => cleanText(item.personalDataAnonymizedAt)).length,
    terminalCredentialsPending: deliveries.filter((item) => isTerminalDelivery(item) && hasDeliveryCredentials(item)).length,
    personalDataPastRetention: deliveries.filter((item) =>
      isTerminalDelivery(item)
      && hasDeliveryPersonalData(item)
      && isOlderThan(terminalDeliveryReference(item), config.deliveryPersonalDataRetentionDays, nowMs)
    ).length,
    evidencePastRetention: deliveries.filter((item) =>
      isTerminalDelivery(item)
      && hasDeliveryEvidence(item)
      && isOlderThan(terminalDeliveryReference(item), config.deliveryEvidenceRetentionDays, nowMs)
    ).length,
    deliveryRecordsPastRetention: deliveries.filter((item) =>
      isTerminalDelivery(item)
      && isOlderThan(terminalDeliveryReference(item), config.deliveryRecordRetentionDays, nowMs)
    ).length,
    auditEntriesPastRetention: auditTrail.filter((entry) => isOlderThan(entry.at, config.auditRetentionDays, nowMs)).length,
    commandsPastRetention: commands.filter((command) =>
      TERMINAL_COMMAND_STATUSES.has(cleanText(command.status))
      && isOlderThan(commandReference(command), config.commandRetentionDays, nowMs)
    ).length,
    notificationsPastRetention: outbox.filter((item) =>
      ['sent', 'failed', 'skipped'].includes(cleanText(item.status))
      && isOlderThan(outboxReference(item), config.notificationRetentionDays, nowMs)
    ).length,
    processedEventsPastRetention: processedEvents.filter((event) =>
      isOlderThan(event.processedAt || event.occurredAt, config.processedEventRetentionDays, nowMs)
    ).length,
  };
}

export function buildPrivacySummary(state = {}, options = {}) {
  const config = options.config ?? normalizePrivacyConfig(options.env);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  return {
    policy: privacyPolicy(config),
    metrics: privacyMetrics(state, config, nowMs),
    lastAppliedAt: cleanText(state.privacy?.lastAppliedAt),
    lastResult: state.privacy?.lastResult && typeof state.privacy.lastResult === 'object'
      ? state.privacy.lastResult
      : null,
  };
}

export function applyPrivacyLifecycle(state = {}, options = {}) {
  const config = options.config ?? normalizePrivacyConfig(options.env);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const appliedAt = isoNow(nowMs);
  const result = {
    credentialsErased: 0,
    evidenceErased: 0,
    deliveriesAnonymized: 0,
    deliveriesRemoved: 0,
    auditEntriesSanitized: 0,
    auditEntriesRemoved: 0,
    commandsRemoved: 0,
    notificationsRemoved: 0,
    processedEventsRemoved: 0,
    doorReferencesRemoved: 0,
  };
  const removedDeliveryIds = new Set();
  const terminalDeliveryIds = new Set();
  const anonymizedDeliveryIds = new Set();

  const deliveries = [];
  for (const delivery of Array.isArray(state.deliveries) ? state.deliveries : []) {
    const reference = terminalDeliveryReference(delivery);
    if (isTerminalDelivery(delivery)) terminalDeliveryIds.add(cleanText(delivery.id));
    if (isTerminalDelivery(delivery) && isOlderThan(reference, config.deliveryRecordRetentionDays, nowMs)) {
      removedDeliveryIds.add(cleanText(delivery.id));
      result.deliveriesRemoved += 1;
      continue;
    }

    let next = delivery;
    const hadCredentials = hasDeliveryCredentials(next);
    next = eraseTerminalDeliveryCredentials(next, appliedAt);
    if (next !== delivery && hadCredentials) result.credentialsErased += 1;

    const hadEvidence = hasDeliveryEvidence(next);
    if (isTerminalDelivery(next) && isOlderThan(reference, config.deliveryEvidenceRetentionDays, nowMs)) {
      const evidenceFree = eraseDeliveryEvidence(next, appliedAt);
      if (evidenceFree !== next && hadEvidence) result.evidenceErased += 1;
      next = evidenceFree;
    }

    if (
      isTerminalDelivery(next)
      && hasDeliveryPersonalData(next)
      && isOlderThan(reference, config.deliveryPersonalDataRetentionDays, nowMs)
    ) {
      next = anonymizeDelivery(next, appliedAt);
      result.deliveriesAnonymized += 1;
    }
    if (cleanText(next.personalDataAnonymizedAt)) {
      anonymizedDeliveryIds.add(cleanText(next.id));
    }
    deliveries.push(next);
  }

  const auditTrail = [];
  for (const entry of Array.isArray(state.auditTrail) ? state.auditTrail : []) {
    if (isOlderThan(entry.at, config.auditRetentionDays, nowMs)) {
      result.auditEntriesRemoved += 1;
      continue;
    }
    const relatedDeliveryWasAnonymized = anonymizedDeliveryIds.has(cleanText(entry.meta?.deliveryId))
      || removedDeliveryIds.has(cleanText(entry.meta?.deliveryId));
    const message = relatedDeliveryWasAnonymized
      ? 'Evento relacionado a entrega anonimizada.'
      : sanitizeAuditMessage(entry.message);
    const meta = sanitizeAuditMeta(entry.meta);
    if (message !== cleanText(entry.message) || JSON.stringify(meta) !== JSON.stringify(entry.meta ?? {})) {
      result.auditEntriesSanitized += 1;
      auditTrail.push({ ...entry, message, meta });
    } else {
      auditTrail.push(entry);
    }
  }

  const commands = (Array.isArray(state.commands) ? state.commands : []).filter((command) => {
    const remove = TERMINAL_COMMAND_STATUSES.has(cleanText(command.status))
      && isOlderThan(commandReference(command), config.commandRetentionDays, nowMs);
    if (remove) result.commandsRemoved += 1;
    return !remove;
  });

  const notificationOutbox = (Array.isArray(state.notificationOutbox) ? state.notificationOutbox : []).filter((item) => {
    const remove = removedDeliveryIds.has(cleanText(item.deliveryId))
      || terminalDeliveryIds.has(cleanText(item.deliveryId))
      || (
        ['sent', 'failed', 'skipped'].includes(cleanText(item.status))
        && isOlderThan(outboxReference(item), config.notificationRetentionDays, nowMs)
      );
    if (remove) result.notificationsRemoved += 1;
    return !remove;
  });

  const processedDeviceEvents = (Array.isArray(state.processedDeviceEvents) ? state.processedDeviceEvents : []).filter((event) => {
    const remove = isOlderThan(
      event.processedAt || event.occurredAt,
      config.processedEventRetentionDays,
      nowMs
    );
    if (remove) result.processedEventsRemoved += 1;
    return !remove;
  });

  const doors = (Array.isArray(state.doors) ? state.doors : []).map((door) => {
    const deliveryId = cleanText(door.delivery?.id);
    if (!deliveryId || (!terminalDeliveryIds.has(deliveryId) && !removedDeliveryIds.has(deliveryId))) return door;
    result.doorReferencesRemoved += 1;
    return { ...door, occupancy: 'free', delivery: null };
  });

  const changedCount = Object.values(result).reduce((total, value) => total + value, 0);
  const changed = changedCount > 0 || options.force === true;
  if (!changed) return { state, changed: false, result };

  const nextState = {
    ...state,
    deliveries,
    commands,
    auditTrail,
    notificationOutbox,
    processedDeviceEvents,
    doors,
    privacy: {
      schemaVersion: PRIVACY_SCHEMA_VERSION,
      lastAppliedAt: appliedAt,
      lastResult: result,
    },
  };
  return { state: nextState, changed: true, result };
}

export function eraseResidentData(state = {}, residentId, options = {}) {
  const normalizedId = cleanText(residentId);
  const residents = Array.isArray(state.residents) ? state.residents : [];
  const resident = residents.find((item) => cleanText(item.id) === normalizedId);
  if (!resident) return { ok: false, status: 404, error: 'Apartamento nao encontrado.' };

  const matchingDeliveries = (Array.isArray(state.deliveries) ? state.deliveries : []).filter(
    (delivery) => cleanText(delivery.recipientId) === normalizedId
  );
  const activeDeliveries = matchingDeliveries.filter(isActiveDelivery);
  if (activeDeliveries.length > 0) {
    return {
      ok: false,
      status: 409,
      error: 'O apartamento possui entrega ativa. Conclua ou regularize a entrega antes da eliminacao.',
      activeDeliveryIds: activeDeliveries.map((delivery) => cleanText(delivery.id)),
    };
  }

  const erasedAt = Number.isFinite(Number(options.nowMs))
    ? isoNow(Number(options.nowMs))
    : new Date().toISOString();
  const deliveryIds = new Set(matchingDeliveries.map((delivery) => cleanText(delivery.id)));
  const deliveries = (Array.isArray(state.deliveries) ? state.deliveries : []).map((delivery) =>
    deliveryIds.has(cleanText(delivery.id)) ? anonymizeDelivery(delivery, erasedAt) : delivery
  );
  return {
    ok: true,
    resident,
    anonymizedDeliveryCount: deliveryIds.size,
    state: {
      ...state,
      residents: residents.filter((item) => cleanText(item.id) !== normalizedId),
      deliveries,
      doors: (Array.isArray(state.doors) ? state.doors : []).map((door) =>
        deliveryIds.has(cleanText(door.delivery?.id)) ? { ...door, occupancy: 'free', delivery: null } : door
      ),
      notificationOutbox: (Array.isArray(state.notificationOutbox) ? state.notificationOutbox : []).filter(
        (item) => !deliveryIds.has(cleanText(item.deliveryId))
      ),
      auditTrail: (Array.isArray(state.auditTrail) ? state.auditTrail : []).map((entry) => {
        const related = cleanText(entry.meta?.residentId) === normalizedId
          || deliveryIds.has(cleanText(entry.meta?.deliveryId));
        return {
          ...entry,
          message: related ? 'Registro relacionado a cadastro eliminado.' : sanitizeAuditMessage(entry.message),
          meta: related
            ? { ...sanitizeAuditMeta(entry.meta), residentId: 'eliminado' }
            : sanitizeAuditMeta(entry.meta),
        };
      }),
    },
  };
}

function exportedDelivery(delivery = {}) {
  return {
    id: cleanText(delivery.id),
    status: cleanText(delivery.status),
    door: Number.parseInt(delivery.door, 10) || null,
    size: cleanText(delivery.size || delivery.doorSize),
    recipientId: cleanText(delivery.recipientId),
    recipientName: cleanText(delivery.recipientName),
    recipientEmail: cleanText(delivery.recipientEmail),
    unit: cleanText(delivery.unit),
    building: cleanText(delivery.building),
    courierName: cleanText(delivery.courierName),
    orderCode: cleanText(delivery.orderCode),
    notes: cleanText(delivery.notes),
    createdAt: cleanText(delivery.createdAt),
    depositedAt: cleanText(delivery.depositedAt),
    pickupOpenedAt: cleanText(delivery.pickupOpenedAt),
    collectedAt: cleanText(delivery.collectedAt),
    cancelledAt: cleanText(delivery.cancelledAt),
    expiresAt: cleanText(delivery.expiresAt),
    notificationStatus: cleanText(delivery.notificationStatus),
    credentials: {
      retained: hasDeliveryCredentials(delivery),
      erasedAt: cleanText(delivery.credentialsErasedAt),
    },
    evidence: {
      retained: hasDeliveryEvidence(delivery),
      capturedAt: cleanText(delivery.labelPhotoCapturedAt),
      erasedAt: cleanText(delivery.evidenceErasedAt),
    },
    personalDataAnonymizedAt: cleanText(delivery.personalDataAnonymizedAt),
  };
}

export function buildResidentDataExport(state = {}, residentId, options = {}) {
  const normalizedId = cleanText(residentId);
  const resident = (Array.isArray(state.residents) ? state.residents : []).find(
    (item) => cleanText(item.id) === normalizedId
  );
  if (!resident) return null;
  const deliveries = (Array.isArray(state.deliveries) ? state.deliveries : []).filter(
    (delivery) => cleanText(delivery.recipientId) === normalizedId
  );
  const deliveryIds = new Set(deliveries.map((delivery) => cleanText(delivery.id)));
  const auditTrail = (Array.isArray(state.auditTrail) ? state.auditTrail : [])
    .filter((entry) =>
      cleanText(entry.meta?.residentId) === normalizedId
      || deliveryIds.has(cleanText(entry.meta?.deliveryId))
    )
    .map((entry) => ({
      id: cleanText(entry.id),
      kind: cleanText(entry.kind),
      message: sanitizeAuditMessage(entry.message),
      at: cleanText(entry.at),
    }));
  return {
    schemaVersion: PRIVACY_SCHEMA_VERSION,
    generatedAt: Number.isFinite(Number(options.nowMs))
      ? isoNow(Number(options.nowMs))
      : new Date().toISOString(),
    resident: { ...resident, cpf: '' },
    deliveries: deliveries.map(exportedDelivery),
    auditTrail,
  };
}

export const PRIVACY_ACTIVE_DELIVERY_STATUSES = Object.freeze([...ACTIVE_DELIVERY_STATUSES]);
