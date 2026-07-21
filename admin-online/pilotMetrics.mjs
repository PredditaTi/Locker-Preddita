export const PILOT_METRIC_SCHEMA_VERSION = 1;
export const MAX_PILOT_METRICS = 500;

const JOURNEY_TYPES = new Set(['courier', 'pickup']);
const JOURNEY_OUTCOMES = new Set(['completed', 'cancelled', 'failed', 'interrupted']);
const PICKUP_MODES = new Set(['none', 'pin', 'qr']);
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

function cleanChoice(value, allowed, fallback) {
  const normalized = String(value ?? '').trim();
  return allowed.has(normalized) ? normalized : fallback;
}

function cleanDate(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return Number.isFinite(Date.parse(normalized)) ? normalized : fallback;
}

export function normalizePilotMetric(raw = {}, event = {}) {
  const metric = raw && typeof raw === 'object' ? raw : {};
  const journeyType = cleanChoice(metric.journeyType, JOURNEY_TYPES, '');
  return {
    schemaVersion: PILOT_METRIC_SCHEMA_VERSION,
    eventId: String(event.id ?? metric.eventId ?? '').trim().slice(0, 160),
    journeyType,
    outcome: cleanChoice(metric.outcome, JOURNEY_OUTCOMES, ''),
    durationMs: Math.min(
      MAX_JOURNEY_DURATION_MS,
      Math.max(0, Number.parseInt(metric.durationMs, 10) || 0),
    ),
    pickupMode: journeyType === 'pickup'
      ? cleanChoice(metric.pickupMode, PICKUP_MODES, 'none')
      : 'none',
    usedSizeFallback: journeyType === 'courier' && Boolean(metric.usedSizeFallback),
    helpRequested: Boolean(metric.helpRequested),
    errorCount: Math.min(MAX_ERROR_COUNT, Math.max(0, Number.parseInt(metric.errorCount, 10) || 0)),
    reasonCode: cleanChoice(metric.reasonCode, REASON_CODES, 'none'),
    occurredAt: cleanDate(event.occurredAt ?? metric.occurredAt, new Date().toISOString()),
    receivedAt: cleanDate(metric.receivedAt, new Date().toISOString()),
  };
}

export function normalizePilotState(value = {}) {
  const pilot = value && typeof value === 'object' ? value : {};
  const metrics = Array.isArray(pilot.metrics)
    ? pilot.metrics
      .map((metric) => normalizePilotMetric(metric, { id: metric?.eventId, occurredAt: metric?.occurredAt }))
      .filter((metric) => metric.eventId && metric.journeyType && metric.outcome)
      .slice(0, MAX_PILOT_METRICS)
    : [];
  return {
    schemaVersion: PILOT_METRIC_SCHEMA_VERSION,
    metrics,
    updatedAt: cleanDate(pilot.updatedAt),
  };
}

export function recordPilotMetric(pilot, rawMetric, event = {}) {
  const current = normalizePilotState(pilot);
  const metric = normalizePilotMetric(rawMetric, event);
  if (!metric.eventId || !metric.journeyType || !metric.outcome) {
    throw new Error('Metrica de piloto invalida.');
  }
  return {
    schemaVersion: PILOT_METRIC_SCHEMA_VERSION,
    metrics: [
      metric,
      ...current.metrics.filter((item) => item.eventId !== metric.eventId),
    ].slice(0, MAX_PILOT_METRICS),
    updatedAt: metric.receivedAt,
  };
}

function percentile(values, percentage) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((percentage / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function percentage(count, total) {
  return total > 0 ? Math.round((count / total) * 1000) / 10 : 0;
}

export function summarizePilotMetrics(pilot = {}) {
  const metrics = normalizePilotState(pilot).metrics;
  const sampleCount = metrics.length;
  const completedCount = metrics.filter((metric) => metric.outcome === 'completed').length;
  const helpRequestCount = metrics.filter((metric) => metric.helpRequested).length;
  const courierMetrics = metrics.filter((metric) => metric.journeyType === 'courier');
  const pickupMetrics = metrics.filter((metric) => metric.journeyType === 'pickup');
  const fallbackCount = courierMetrics.filter((metric) => metric.usedSizeFallback).length;
  const durations = metrics.map((metric) => metric.durationMs);

  return {
    sampleCount,
    completedCount,
    cancelledCount: metrics.filter((metric) => metric.outcome === 'cancelled').length,
    failedCount: metrics.filter((metric) => metric.outcome === 'failed').length,
    interruptedCount: metrics.filter((metric) => metric.outcome === 'interrupted').length,
    completionPercentage: percentage(completedCount, sampleCount),
    helpRequestCount,
    helpRequestPercentage: percentage(helpRequestCount, sampleCount),
    fallbackCount,
    fallbackPercentage: percentage(fallbackCount, courierMetrics.length),
    errorCount: metrics.reduce((total, metric) => total + metric.errorCount, 0),
    medianDurationMs: percentile(durations, 50),
    p95DurationMs: percentile(durations, 95),
    courierCount: courierMetrics.length,
    pickupCount: pickupMetrics.length,
    pinPickupCount: pickupMetrics.filter((metric) => metric.pickupMode === 'pin').length,
    qrPickupCount: pickupMetrics.filter((metric) => metric.pickupMode === 'qr').length,
    updatedAt: metrics[0]?.receivedAt || '',
  };
}
