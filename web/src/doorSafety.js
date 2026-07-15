export const DOOR_READING_MAX_AGE_MS = 20_000;
export const DEFAULT_SENSOR_POLARITY = 'zeroOpen';

const VALID_OPERATIONS = new Set(['dropoff', 'pickup', 'remote-admin']);
const VALID_POLARITIES = new Set(['zeroOpen', 'zeroClosed']);

function cleanText(value) {
  return String(value ?? '').trim();
}

function parseTimestamp(value) {
  const timestamp = Date.parse(cleanText(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeStateByte(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xff ? parsed : null;
}

export function normalizeSensorPolarity(value) {
  return VALID_POLARITIES.has(value) ? value : DEFAULT_SENSOR_POLARITY;
}

export function normalizeDoorReading(reading = {}) {
  const source = reading && typeof reading === 'object' ? reading : {};
  return {
    channel: Number.parseInt(source.channel, 10),
    status: ['open', 'closed'].includes(source.status) ? source.status : 'unknown',
    detail: cleanText(source.detail),
    source: cleanText(source.source) || 'none',
    stateByte: normalizeStateByte(source.stateByte),
    statusKnown: Boolean(source.statusKnown),
    validChecksum: Boolean(source.validChecksum),
    ambiguous: Boolean(source.ambiguous),
    sensorPolarity: VALID_POLARITIES.has(source.sensorPolarity)
      ? source.sensorPolarity
      : DEFAULT_SENSOR_POLARITY,
    readAt: cleanText(source.readAt),
  };
}

export function validateDirectDoorReading(reading, expectedStatus, options = {}) {
  const normalized = normalizeDoorReading(reading);
  const expectedChannel = Number.parseInt(options.channel, 10);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs)
    ? Math.max(0, options.maxAgeMs)
    : DOOR_READING_MAX_AGE_MS;
  const readTimestamp = parseTimestamp(normalized.readAt);
  const afterTimestamp = parseTimestamp(options.after);

  if (normalized.source !== 'single') {
    return { ok: false, reason: 'not-direct', reading: normalized };
  }
  if (!normalized.validChecksum) {
    return { ok: false, reason: 'invalid-checksum', reading: normalized };
  }
  if (!normalized.statusKnown || normalized.ambiguous) {
    return { ok: false, reason: 'ambiguous-status', reading: normalized };
  }
  if (normalized.status !== expectedStatus) {
    return { ok: false, reason: `expected-${expectedStatus}`, reading: normalized };
  }
  if (normalized.stateByte === null || readTimestamp === null) {
    return { ok: false, reason: 'incomplete-reading', reading: normalized };
  }
  if (Number.isInteger(expectedChannel) && normalized.channel !== expectedChannel) {
    return { ok: false, reason: 'wrong-channel', reading: normalized };
  }
  if (readTimestamp > now + 1_000 || now - readTimestamp > maxAgeMs) {
    return { ok: false, reason: 'stale-reading', reading: normalized };
  }
  if (afterTimestamp !== null && readTimestamp <= afterTimestamp) {
    return { ok: false, reason: 'reading-before-transition', reading: normalized };
  }

  return { ok: true, reason: 'confirmed', reading: normalized };
}

export function normalizeDoorOpenCycle(cycle = {}) {
  const source = cycle && typeof cycle === 'object' ? cycle : {};
  return {
    version: 1,
    operation: VALID_OPERATIONS.has(source.operation) ? source.operation : '',
    channel: Number.parseInt(source.channel, 10),
    sensorPolarity: VALID_POLARITIES.has(source.sensorPolarity)
      ? source.sensorPolarity
      : '',
    closedStateByte: normalizeStateByte(source.closedStateByte),
    openStateByte: normalizeStateByte(source.openStateByte),
    baselineReadAt: cleanText(source.baselineReadAt),
    openedAt: cleanText(source.openedAt),
  };
}

export function isValidDoorOpenCycle(cycle, options = {}) {
  const normalized = normalizeDoorOpenCycle(cycle);
  const baselineTimestamp = parseTimestamp(normalized.baselineReadAt);
  const openedTimestamp = parseTimestamp(normalized.openedAt);
  const expectedChannel = Number.parseInt(options.channel, 10);
  const expectedOperation = cleanText(options.operation);

  return Boolean(
    normalized.operation &&
      Number.isInteger(normalized.channel) &&
      normalized.channel > 0 &&
      normalized.sensorPolarity &&
      normalized.closedStateByte !== null &&
      normalized.openStateByte !== null &&
      normalized.closedStateByte !== normalized.openStateByte &&
      baselineTimestamp !== null &&
      openedTimestamp !== null &&
      openedTimestamp > baselineTimestamp &&
      (!Number.isInteger(expectedChannel) || normalized.channel === expectedChannel) &&
      (!expectedOperation || normalized.operation === expectedOperation)
  );
}

export function createDoorOpenCycle(closedReading, openReading, operation) {
  const closedResult = validateDirectDoorReading(closedReading, 'closed');
  if (!closedResult.ok) return closedResult;

  const openResult = validateDirectDoorReading(openReading, 'open', {
    channel: closedResult.reading.channel,
    after: closedResult.reading.readAt,
  });
  if (!openResult.ok) return openResult;

  if (!VALID_OPERATIONS.has(operation)) {
    return { ok: false, reason: 'invalid-operation' };
  }
  if (closedResult.reading.sensorPolarity !== openResult.reading.sensorPolarity) {
    return { ok: false, reason: 'polarity-changed' };
  }
  if (closedResult.reading.stateByte === openResult.reading.stateByte) {
    return { ok: false, reason: 'sensor-did-not-transition' };
  }

  const cycle = normalizeDoorOpenCycle({
    operation,
    channel: closedResult.reading.channel,
    sensorPolarity: closedResult.reading.sensorPolarity,
    closedStateByte: closedResult.reading.stateByte,
    openStateByte: openResult.reading.stateByte,
    baselineReadAt: closedResult.reading.readAt,
    openedAt: openResult.reading.readAt,
  });

  return isValidDoorOpenCycle(cycle)
    ? { ok: true, reason: 'confirmed', cycle }
    : { ok: false, reason: 'invalid-cycle' };
}

export function normalizeDoorCloseProof(proof = {}) {
  const source = proof && typeof proof === 'object' ? proof : {};
  return {
    version: 1,
    channel: Number.parseInt(source.channel, 10),
    sensorPolarity: VALID_POLARITIES.has(source.sensorPolarity)
      ? source.sensorPolarity
      : '',
    stateByte: normalizeStateByte(source.stateByte),
    openedAt: cleanText(source.openedAt),
    closedAt: cleanText(source.closedAt),
  };
}

export function isValidDoorCloseProof(cycle, proof) {
  const normalizedCycle = normalizeDoorOpenCycle(cycle);
  const normalizedProof = normalizeDoorCloseProof(proof);
  const openedTimestamp = parseTimestamp(normalizedCycle.openedAt);
  const closedTimestamp = parseTimestamp(normalizedProof.closedAt);

  return Boolean(
    isValidDoorOpenCycle(normalizedCycle) &&
      normalizedProof.channel === normalizedCycle.channel &&
      normalizedProof.sensorPolarity === normalizedCycle.sensorPolarity &&
      normalizedProof.stateByte === normalizedCycle.closedStateByte &&
      normalizedProof.openedAt === normalizedCycle.openedAt &&
      openedTimestamp !== null &&
      closedTimestamp !== null &&
      closedTimestamp > openedTimestamp
  );
}

export function createDoorCloseProof(cycle, closedReading) {
  const normalizedCycle = normalizeDoorOpenCycle(cycle);
  if (!isValidDoorOpenCycle(normalizedCycle)) {
    return { ok: false, reason: 'invalid-open-cycle' };
  }

  const closedResult = validateDirectDoorReading(closedReading, 'closed', {
    channel: normalizedCycle.channel,
    after: normalizedCycle.openedAt,
  });
  if (!closedResult.ok) return closedResult;
  if (closedResult.reading.sensorPolarity !== normalizedCycle.sensorPolarity) {
    return { ok: false, reason: 'polarity-changed', reading: closedResult.reading };
  }
  if (closedResult.reading.stateByte !== normalizedCycle.closedStateByte) {
    return { ok: false, reason: 'unexpected-closed-state', reading: closedResult.reading };
  }

  const proof = normalizeDoorCloseProof({
    channel: normalizedCycle.channel,
    sensorPolarity: normalizedCycle.sensorPolarity,
    stateByte: closedResult.reading.stateByte,
    openedAt: normalizedCycle.openedAt,
    closedAt: closedResult.reading.readAt,
  });

  return isValidDoorCloseProof(normalizedCycle, proof)
    ? { ok: true, reason: 'confirmed', proof }
    : { ok: false, reason: 'invalid-close-proof' };
}
