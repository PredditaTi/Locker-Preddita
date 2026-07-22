export const DELIVERY_MODES = Object.freeze({
  MANUAL: 'manual',
  SMART: 'smart',
});

export const PACKAGE_ANALYSIS_STATUSES = Object.freeze({
  IDLE: 'idle',
  CAPTURING: 'capturing',
  ANALYZING: 'analyzing',
  READY: 'ready',
  UNCERTAIN: 'uncertain',
  FAILED: 'failed',
});

export const MIN_PACKAGE_ANALYSIS_CONFIDENCE = 0.9;
export const PACKAGE_RECOMMENDATION_MAX_AGE_MS = 120_000;

const DELIVERY_MODE_VALUES = new Set(Object.values(DELIVERY_MODES));
const PACKAGE_ANALYSIS_STATUS_VALUES = new Set(Object.values(PACKAGE_ANALYSIS_STATUSES));
const PACKAGE_SIZE_VALUES = new Set(['P', 'G']);

function cleanText(value) {
  return String(value ?? '').trim();
}

function normalizeConfidence(value) {
  if (value === null || value === undefined || value === '') return null;
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return null;
  return Math.min(1, Math.max(0, confidence));
}

function normalizeSha256(value) {
  const checksum = cleanText(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(checksum) ? checksum : '';
}

function normalizeCapturedAt(value) {
  const timestamp = cleanText(value).slice(0, 40);
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : '';
}

export function normalizeDeliveryMode(value) {
  const mode = cleanText(value).toLowerCase();
  return DELIVERY_MODE_VALUES.has(mode) ? mode : '';
}

export function normalizePackageAnalysis(value = {}) {
  const status = cleanText(value.status).toLowerCase();
  const suggestedSize = cleanText(value.suggestedSize).toUpperCase();

  return {
    status: PACKAGE_ANALYSIS_STATUS_VALUES.has(status)
      ? status
      : PACKAGE_ANALYSIS_STATUSES.IDLE,
    suggestedSize: PACKAGE_SIZE_VALUES.has(suggestedSize) ? suggestedSize : '',
    confidence: normalizeConfidence(value.confidence),
    captureQuality: normalizeConfidence(value.captureQuality),
    capturedAt: normalizeCapturedAt(value.capturedAt),
    modelVersion: cleanText(value.modelVersion).slice(0, 80),
    modelSha256: normalizeSha256(value.modelSha256),
    inferenceMs: Math.max(0, Number.parseInt(value.inferenceMs, 10) || 0),
    reasonCode: cleanText(value.reasonCode).slice(0, 80),
  };
}

export function createEmptyPackageAnalysis() {
  return normalizePackageAnalysis();
}

export function canOpenDoorFromPackageAnalysis(value = {}) {
  const analysis = normalizePackageAnalysis(value);
  return analysis.status === PACKAGE_ANALYSIS_STATUSES.READY
    && PACKAGE_SIZE_VALUES.has(analysis.suggestedSize)
    && analysis.confidence !== null
    && analysis.confidence >= MIN_PACKAGE_ANALYSIS_CONFIDENCE
    && Boolean(analysis.modelVersion)
    && Boolean(analysis.modelSha256);
}

export function createSmartDoorRecommendation(value = {}, options = {}) {
  const analysis = normalizePackageAnalysis(value);
  if (!canOpenDoorFromPackageAnalysis(analysis)) return null;
  const capturedAtMs = Date.parse(analysis.capturedAt);
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const ageMs = nowMs - capturedAtMs;
  if (!Number.isFinite(capturedAtMs) || ageMs < -30_000 || ageMs > PACKAGE_RECOMMENDATION_MAX_AGE_MS) {
    return null;
  }
  return Object.freeze({
    packageSize: analysis.suggestedSize,
    confidence: analysis.confidence,
    modelVersion: analysis.modelVersion,
    modelSha256: analysis.modelSha256,
    inferenceMs: analysis.inferenceMs,
    capturedAt: analysis.capturedAt,
  });
}
