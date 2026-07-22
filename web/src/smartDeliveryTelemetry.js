export const SMART_DELIVERY_TELEMETRY_STORAGE_KEY = 'preddita_smart_delivery_telemetry_v1';
export const SMART_DELIVERY_TELEMETRY_SCHEMA_VERSION = 1;
export const SMART_DELIVERY_TELEMETRY_RETENTION_DAYS = 7;
export const MAX_SMART_DELIVERY_TELEMETRY_EVENTS = 100;

const ACTIONS = new Set(['analysis', 'recommendation', 'allocation']);
const OUTCOMES_BY_ACTION = Object.freeze({
  analysis: new Set(['ready', 'uncertain', 'failed']),
  recommendation: new Set(['confirmed', 'expired', 'manual-fallback']),
  allocation: new Set(['opened', 'unavailable', 'failed']),
});
const SIZES = new Set(['P', 'G']);
const QUALITY_BANDS = new Set(['unknown', 'low', 'accepted', 'high']);
const REASON_CODES = new Set([
  'none',
  'model-not-installed',
  'model-checksum-mismatch',
  'model-runtime-not-installed',
  'low-capture-quality',
  'analyzer-unavailable',
  'analyzer-timeout',
  'analyzer-busy',
  'analyzer-error',
  'invalid-analyzer-result',
  'invalid-image',
  'unsupported-schema',
  'unsafe-analysis-result',
  'unverified-model-result',
  'recommendation-expired',
  'door-unavailable',
  'door-actuation-failed',
  'user-selected-manual',
]);
const RETENTION_MS = SMART_DELIVERY_TELEMETRY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

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

function normalizeModelVersion(value) {
  const normalized = String(value ?? '').trim();
  return /^[A-Za-z0-9._-]{1,40}$/.test(normalized) ? normalized : '';
}

function qualityBand(value) {
  const storedBand = String(value ?? '').trim();
  if (QUALITY_BANDS.has(storedBand)) return storedBand;
  const quality = Number(value);
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) return 'unknown';
  if (quality < 0.6) return 'low';
  return quality >= 0.85 ? 'high' : 'accepted';
}

function normalizeEvent(raw = {}, fallbackOccurredAt = '') {
  const action = cleanChoice(raw.action, ACTIONS, '');
  const outcome = cleanChoice(raw.outcome, OUTCOMES_BY_ACTION[action] || new Set(), '');
  const occurredAt = String(raw.occurredAt ?? fallbackOccurredAt).trim();
  if (!action || !outcome || !Number.isFinite(Date.parse(occurredAt))) return null;
  const size = cleanChoice(raw.size, SIZES, '');
  const inferenceMs = Math.min(15_000, Math.max(0, Number.parseInt(raw.inferenceMs, 10) || 0));
  return {
    action,
    outcome,
    size: (action === 'analysis' && outcome === 'ready')
      || (action === 'recommendation' && outcome === 'confirmed')
      || action === 'allocation'
      ? size
      : '',
    reasonCode: cleanChoice(raw.reasonCode, REASON_CODES, 'none'),
    captureQualityBand: qualityBand(raw.captureQuality ?? raw.captureQualityBand),
    inferenceMs: Math.round(inferenceMs / 10) * 10,
    modelVersion: normalizeModelVersion(raw.modelVersion),
    occurredAt,
  };
}

function readState(options = {}) {
  const storage = safeStorage(options.storage);
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  if (!storage) return { schemaVersion: SMART_DELIVERY_TELEMETRY_SCHEMA_VERSION, events: [] };
  try {
    const parsed = JSON.parse(storage.getItem(SMART_DELIVERY_TELEMETRY_STORAGE_KEY) || '{}');
    const events = Array.isArray(parsed.events) ? parsed.events : [];
    return {
      schemaVersion: SMART_DELIVERY_TELEMETRY_SCHEMA_VERSION,
      events: events
        .map((event) => normalizeEvent(event))
        .filter((event) => {
          if (!event) return false;
          const ageMs = nowMs - Date.parse(event.occurredAt);
          return ageMs >= -5 * 60 * 1000 && ageMs <= RETENTION_MS;
        })
        .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
        .slice(0, MAX_SMART_DELIVERY_TELEMETRY_EVENTS),
    };
  } catch (_error) {
    return { schemaVersion: SMART_DELIVERY_TELEMETRY_SCHEMA_VERSION, events: [] };
  }
}

function writeState(storage, state) {
  if (!storage) return;
  try {
    if (state.events.length === 0) {
      storage.removeItem(SMART_DELIVERY_TELEMETRY_STORAGE_KEY);
      return;
    }
    storage.setItem(SMART_DELIVERY_TELEMETRY_STORAGE_KEY, JSON.stringify(state));
  } catch (_error) {
  }
}

export function recordSmartDeliveryTelemetry(raw = {}, options = {}) {
  const storage = safeStorage(options.storage);
  const occurredAt = String(options.occurredAt ?? '').trim() || new Date().toISOString();
  const event = normalizeEvent(raw, occurredAt);
  if (!storage || !event) return null;
  const current = readState({ storage, nowMs: Date.parse(occurredAt) });
  const next = {
    schemaVersion: SMART_DELIVERY_TELEMETRY_SCHEMA_VERSION,
    events: [event, ...current.events].slice(0, MAX_SMART_DELIVERY_TELEMETRY_EVENTS),
  };
  writeState(storage, next);
  return event;
}

export function getSmartDeliveryTelemetrySummary(options = {}) {
  const state = readState(options);
  const count = (action, outcome) => state.events.filter(
    (event) => event.action === action && (!outcome || event.outcome === outcome)
  ).length;
  const inferenceValues = state.events
    .filter((event) => event.action === 'analysis' && event.inferenceMs > 0)
    .map((event) => event.inferenceMs)
    .sort((left, right) => left - right);
  const p95Index = Math.max(0, Math.ceil(inferenceValues.length * 0.95) - 1);
  return {
    schemaVersion: SMART_DELIVERY_TELEMETRY_SCHEMA_VERSION,
    retentionDays: SMART_DELIVERY_TELEMETRY_RETENTION_DAYS,
    eventCount: state.events.length,
    analysisCount: count('analysis'),
    readyPCount: state.events.filter((event) => event.action === 'analysis' && event.outcome === 'ready' && event.size === 'P').length,
    readyGCount: state.events.filter((event) => event.action === 'analysis' && event.outcome === 'ready' && event.size === 'G').length,
    uncertainCount: count('analysis', 'uncertain'),
    failedCount: count('analysis', 'failed'),
    recommendationConfirmedCount: count('recommendation', 'confirmed'),
    manualFallbackCount: count('recommendation', 'manual-fallback'),
    openedCount: count('allocation', 'opened'),
    unavailableCount: count('allocation', 'unavailable'),
    allocationFailedCount: count('allocation', 'failed'),
    inferenceP95Ms: inferenceValues.length ? inferenceValues[p95Index] : 0,
    lastEventAt: state.events[0]?.occurredAt || '',
  };
}

export function clearSmartDeliveryTelemetry(options = {}) {
  const storage = safeStorage(options.storage);
  if (!storage) return false;
  try {
    storage.removeItem(SMART_DELIVERY_TELEMETRY_STORAGE_KEY);
    return true;
  } catch (_error) {
    return false;
  }
}
