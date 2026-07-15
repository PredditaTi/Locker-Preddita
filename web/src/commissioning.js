import {
  isValidDoorCloseProof,
  isValidDoorOpenCycle,
  normalizeDoorCloseProof,
  normalizeDoorOpenCycle,
  normalizeSensorPolarity,
} from './doorSafety.js';

export const DEFAULT_UNLOCK_TIMEOUT_SECONDS = 3;
export const MIN_UNLOCK_TIMEOUT_SECONDS = 1;
export const MAX_UNLOCK_TIMEOUT_SECONDS = 30;
export const DOOR_SIZE_OPTIONS = [
  { id: 'P', label: 'Pequena' },
  { id: 'M', label: 'Media' },
  { id: 'G', label: 'Grande' },
];

const VALID_DOOR_SIZES = new Set(DOOR_SIZE_OPTIONS.map((option) => option.id));

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function cleanText(value) {
  return String(value ?? '').trim();
}

export function getDefaultDoorSize(channel) {
  return Number(channel) <= 2 ? 'G' : 'P';
}

export function normalizeUnlockTimeoutSeconds(value) {
  return clampInteger(
    value,
    MIN_UNLOCK_TIMEOUT_SECONDS,
    MAX_UNLOCK_TIMEOUT_SECONDS,
    DEFAULT_UNLOCK_TIMEOUT_SECONDS,
  );
}

export function normalizeDoorSizes(values, doorCount = 24) {
  const safeCount = clampInteger(doorCount, 1, 24, 24);
  const source = Array.isArray(values) ? values : [];

  return Array.from({ length: safeCount }, (_, index) => {
    const value = cleanText(source[index]).toUpperCase();
    return VALID_DOOR_SIZES.has(value) ? value : getDefaultDoorSize(index + 1);
  });
}

export function inferSensorPolarityFromClosedStateByte(stateByte) {
  const parsed = Number(stateByte);
  if (parsed === 0x00) return 'zeroClosed';
  if (parsed === 0x11) return 'zeroOpen';
  return '';
}

export function normalizeCommissioningChannel(channel = {}, expectedChannel) {
  const number = clampInteger(channel.channel ?? expectedChannel, 1, 24, expectedChannel);
  const cycle = isValidDoorOpenCycle(channel.cycle, {
    channel: number,
    operation: 'commissioning',
  }) ? normalizeDoorOpenCycle(channel.cycle) : null;
  const closeProof = cycle && isValidDoorCloseProof(cycle, channel.closeProof)
    ? normalizeDoorCloseProof(channel.closeProof)
    : null;

  return {
    channel: number,
    size: VALID_DOOR_SIZES.has(channel.size) ? channel.size : getDefaultDoorSize(number),
    status: cycle && closeProof ? 'passed' : 'pending',
    cycle,
    closeProof,
  };
}

export function normalizeCommissioningChannels(channels, doorCount, doorSizes) {
  const sizes = normalizeDoorSizes(doorSizes, doorCount);
  const byChannel = Array.isArray(channels)
    ? new Map(channels.map((channel) => [Number.parseInt(channel?.channel, 10), channel]))
    : new Map();

  return sizes.map((size, index) => {
    const channel = index + 1;
    return normalizeCommissioningChannel(
      { ...(byChannel.get(channel) ?? {}), channel, size },
      channel,
    );
  });
}

export function createPendingCommissioning(config = {}) {
  const doorCount = clampInteger(config.doorCount, 1, 24, 24);
  const doorSizes = normalizeDoorSizes(config.doorSizes, doorCount);

  return {
    version: 1,
    status: 'pending',
    board: clampInteger(config.board, 1, 31, 1),
    doorCount,
    sensorPolarity: normalizeSensorPolarity(config.sensorPolarity),
    unlockTimeoutSeconds: normalizeUnlockTimeoutSeconds(config.unlockTimeoutSeconds),
    startedAt: cleanText(config.startedAt),
    completedAt: '',
    channels: normalizeCommissioningChannels(config.channels, doorCount, doorSizes),
  };
}

export function normalizeCommissioningRecord(record, config = {}) {
  const source = record && typeof record === 'object' ? record : {};
  const hasConfig = config && typeof config === 'object' && Object.keys(config).length > 0;
  const sourceDoorCount = clampInteger(source.doorCount, 1, 24, 24);
  const configDoorCount = clampInteger(config.doorCount, 1, 24, sourceDoorCount);
  const sourceDoorSizes = normalizeDoorSizes(
    source.doorSizes ?? source.channels?.map((channel) => channel?.size),
    sourceDoorCount,
  );
  const configDoorSizes = normalizeDoorSizes(config.doorSizes, configDoorCount);
  const matchesConfig = !hasConfig || Boolean(
    clampInteger(source.board, 1, 31, 1) === clampInteger(config.board, 1, 31, 1) &&
    sourceDoorCount === configDoorCount &&
    normalizeSensorPolarity(source.sensorPolarity) === normalizeSensorPolarity(config.sensorPolarity) &&
    normalizeUnlockTimeoutSeconds(source.unlockTimeoutSeconds) === normalizeUnlockTimeoutSeconds(config.unlockTimeoutSeconds) &&
    sourceDoorSizes.every((size, index) => size === configDoorSizes[index])
  );
  const base = createPendingCommissioning({
    ...source,
    ...config,
    channels: source.channels,
  });
  const completedAt = cleanText(record?.completedAt);
  const allPassed = base.channels.length === base.doorCount &&
    base.channels.every((channel) => channel.status === 'passed');

  return {
    ...base,
    status: record?.status === 'complete' && completedAt && allPassed && matchesConfig ? 'complete' : 'pending',
    completedAt: record?.status === 'complete' && completedAt && allPassed && matchesConfig ? completedAt : '',
  };
}

export function buildCommissioningRecord(config = {}) {
  const record = normalizeCommissioningRecord(
    {
      ...config,
      status: 'complete',
      completedAt: cleanText(config.completedAt) || new Date().toISOString(),
    },
    config,
  );

  if (record.status !== 'complete') {
    throw new Error('Todos os canais precisam concluir o ciclo fisico antes de salvar.');
  }

  const polarities = new Set(record.channels.map((channel) => channel.cycle.sensorPolarity));
  if (polarities.size !== 1 || !polarities.has(record.sensorPolarity)) {
    throw new Error('Os canais nao confirmaram a mesma polaridade de sensor.');
  }

  return record;
}

export function isCommissioningCurrent(record, config = {}) {
  const normalized = normalizeCommissioningRecord(record, config);
  const doorSizes = normalizeDoorSizes(config.doorSizes, config.doorCount);

  return Boolean(
    normalized.status === 'complete' &&
      normalized.board === Number(config.board) &&
      normalized.doorCount === Number(config.doorCount) &&
      normalized.sensorPolarity === normalizeSensorPolarity(config.sensorPolarity) &&
      normalized.unlockTimeoutSeconds === normalizeUnlockTimeoutSeconds(config.unlockTimeoutSeconds) &&
      normalized.channels.every((channel, index) => channel.size === doorSizes[index])
  );
}
