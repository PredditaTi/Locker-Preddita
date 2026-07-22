export const PILOT_JOURNEY_STORAGE_KEY = 'preddita_active_pilot_journey_v1';
export const PILOT_METRIC_SCHEMA_VERSION = 2;

const JOURNEY_TYPES = new Set(['courier', 'pickup']);
const JOURNEY_OUTCOMES = new Set(['completed', 'cancelled', 'failed', 'interrupted']);
const PICKUP_MODES = new Set(['none', 'pin', 'qr']);
const DELIVERY_MODES = new Set(['none', 'manual', 'smart']);
const SMART_ANALYSIS_OUTCOMES = new Set(['not-run', 'P', 'G', 'uncertain', 'failed']);
const SMART_DOOR_OUTCOMES = new Set(['not-requested', 'opened', 'unavailable', 'failed']);
const REASON_CODES = new Set([
  'none',
  'user-cancelled',
  'app-restarted',
  'door-unavailable',
  'door-actuation-failed',
  'door-close-timeout',
  'invalid-credential',
  'camera-unavailable',
  'unexpected-error',
]);
const MAX_JOURNEY_DURATION_MS = 30 * 60 * 1000;
const MAX_ERROR_COUNT = 20;

function safeStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch (_error) {
    return null;
  }
}

function cleanChoice(value, allowed, fallback) {
  const normalized = String(value ?? '').trim();
  return allowed.has(normalized) ? normalized : fallback;
}

function createJourneyId(now) {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `journey-${Date.parse(now).toString(36)}-${suffix}`;
}

function normalizeJourney(value) {
  if (!value || typeof value !== 'object') return null;
  const journeyType = cleanChoice(value.journeyType, JOURNEY_TYPES, '');
  const startedAt = String(value.startedAt ?? '').trim();
  const journeyId = String(value.journeyId ?? '').trim();
  if (!journeyType || !journeyId || !Number.isFinite(Date.parse(startedAt))) return null;

  return {
    journeyId,
    journeyType,
    startedAt,
    pickupMode: cleanChoice(value.pickupMode, PICKUP_MODES, 'none'),
    deliveryMode: cleanChoice(value.deliveryMode, DELIVERY_MODES, 'none'),
    smartAnalysisOutcome: cleanChoice(
      value.smartAnalysisOutcome,
      SMART_ANALYSIS_OUTCOMES,
      'not-run',
    ),
    smartRecommendationConfirmed: Boolean(value.smartRecommendationConfirmed),
    smartDoorOutcome: cleanChoice(value.smartDoorOutcome, SMART_DOOR_OUTCOMES, 'not-requested'),
    usedSizeFallback: Boolean(value.usedSizeFallback),
    helpRequested: Boolean(value.helpRequested),
    errorCount: Math.min(MAX_ERROR_COUNT, Math.max(0, Number.parseInt(value.errorCount, 10) || 0)),
  };
}

function readJourney(storage) {
  const target = safeStorage(storage);
  if (!target) return null;
  try {
    return normalizeJourney(JSON.parse(target.getItem(PILOT_JOURNEY_STORAGE_KEY) || 'null'));
  } catch (_error) {
    return null;
  }
}

function writeJourney(storage, journey) {
  const target = safeStorage(storage);
  if (!target) return;
  try {
    if (!journey) {
      target.removeItem(PILOT_JOURNEY_STORAGE_KEY);
      return;
    }
    target.setItem(PILOT_JOURNEY_STORAGE_KEY, JSON.stringify(journey));
  } catch (_error) {
  }
}

function buildMetric(journey, outcome, options = {}) {
  const occurredAt = String(options.occurredAt ?? '').trim() || new Date().toISOString();
  const elapsed = Date.parse(occurredAt) - Date.parse(journey.startedAt);
  return {
    id: `pilot-${journey.journeyId}-${outcome}`,
    occurredAt,
    payload: {
      schemaVersion: PILOT_METRIC_SCHEMA_VERSION,
      journeyType: journey.journeyType,
      outcome: cleanChoice(outcome, JOURNEY_OUTCOMES, 'failed'),
      durationMs: Math.min(MAX_JOURNEY_DURATION_MS, Math.max(0, Number.isFinite(elapsed) ? elapsed : 0)),
      pickupMode: journey.journeyType === 'pickup'
        ? cleanChoice(options.pickupMode ?? journey.pickupMode, PICKUP_MODES, 'none')
        : 'none',
      usedSizeFallback: journey.journeyType === 'courier' && Boolean(journey.usedSizeFallback),
      helpRequested: Boolean(journey.helpRequested),
      errorCount: journey.errorCount,
      reasonCode: cleanChoice(options.reasonCode, REASON_CODES, 'none'),
      deliveryMode: journey.journeyType === 'courier'
        ? cleanChoice(journey.deliveryMode, DELIVERY_MODES, 'none')
        : 'none',
      smartAnalysisOutcome: journey.journeyType === 'courier'
        ? cleanChoice(journey.smartAnalysisOutcome, SMART_ANALYSIS_OUTCOMES, 'not-run')
        : 'not-run',
      smartRecommendationConfirmed: journey.journeyType === 'courier'
        && Boolean(journey.smartRecommendationConfirmed),
      smartDoorOutcome: journey.journeyType === 'courier'
        ? cleanChoice(journey.smartDoorOutcome, SMART_DOOR_OUTCOMES, 'not-requested')
        : 'not-requested',
    },
  };
}

export function startPilotJourney(options = {}) {
  const storage = safeStorage(options.storage);
  const requestedStartedAt = String(options.startedAt ?? '').trim();
  const startedAt = Number.isFinite(Date.parse(requestedStartedAt))
    ? requestedStartedAt
    : new Date().toISOString();
  const previous = readJourney(storage);
  const interruptedMetric = previous
    ? buildMetric(previous, 'interrupted', { occurredAt: startedAt, reasonCode: 'app-restarted' })
    : null;
  const journeyType = cleanChoice(options.journeyType, JOURNEY_TYPES, '');
  if (!journeyType) return { journey: null, interruptedMetric };

  const journey = {
    journeyId: createJourneyId(startedAt),
    journeyType,
    startedAt,
    pickupMode: 'none',
    deliveryMode: 'none',
    smartAnalysisOutcome: 'not-run',
    smartRecommendationConfirmed: false,
    smartDoorOutcome: 'not-requested',
    usedSizeFallback: false,
    helpRequested: false,
    errorCount: 0,
  };
  writeJourney(storage, journey);
  return { journey, interruptedMetric };
}

export function recordPilotJourneySignal(options = {}) {
  const storage = safeStorage(options.storage);
  const journey = readJourney(storage);
  if (!journey) return null;

  const signal = String(options.signal ?? '').trim();
  const next = {
    ...journey,
    pickupMode: signal === 'pickup-mode'
      ? cleanChoice(options.pickupMode, PICKUP_MODES, journey.pickupMode)
      : journey.pickupMode,
    deliveryMode: signal === 'delivery-mode'
      ? cleanChoice(options.deliveryMode, DELIVERY_MODES, journey.deliveryMode)
      : journey.deliveryMode,
    smartAnalysisOutcome: signal === 'smart-analysis'
      ? cleanChoice(options.analysisOutcome, SMART_ANALYSIS_OUTCOMES, journey.smartAnalysisOutcome)
      : journey.smartAnalysisOutcome,
    smartRecommendationConfirmed: journey.smartRecommendationConfirmed
      || signal === 'smart-recommendation-confirmed',
    smartDoorOutcome: signal === 'smart-door-outcome'
      ? cleanChoice(options.doorOutcome, SMART_DOOR_OUTCOMES, journey.smartDoorOutcome)
      : journey.smartDoorOutcome,
    usedSizeFallback: journey.usedSizeFallback || signal === 'size-fallback',
    helpRequested: journey.helpRequested || signal === 'help',
    errorCount: signal === 'error'
      ? Math.min(MAX_ERROR_COUNT, journey.errorCount + 1)
      : journey.errorCount,
  };
  writeJourney(storage, next);
  return next;
}

export function completePilotJourney(options = {}) {
  const storage = safeStorage(options.storage);
  const journey = readJourney(storage);
  if (!journey) return null;
  const metric = buildMetric(journey, options.outcome, options);
  writeJourney(storage, null);
  return metric;
}

export function recoverInterruptedPilotJourney(options = {}) {
  return completePilotJourney({
    ...options,
    outcome: 'interrupted',
    reasonCode: 'app-restarted',
  });
}

export function getActivePilotJourney(storage) {
  return readJourney(storage);
}
