import {
  PACKAGE_ANALYSIS_STATUSES,
  canOpenDoorFromPackageAnalysis,
  normalizePackageAnalysis,
} from './smartDelivery.js';

export const PACKAGE_ANALYZER_EVENT = 'preddita-package-analysis';
export const PACKAGE_ANALYZER_SCHEMA_VERSION = 1;
export const PACKAGE_ANALYZER_TIMEOUT_MS = 5000;
export const PACKAGE_ANALYZER_MAX_IMAGE_CHARS = 900_000;

function failedAnalysis(reasonCode, captureQuality = null) {
  return normalizePackageAnalysis({
    status: PACKAGE_ANALYSIS_STATUSES.FAILED,
    captureQuality,
    reasonCode,
  });
}

function createRequestId(runtime = globalThis) {
  const uuid = runtime.crypto?.randomUUID?.();
  if (uuid) return `package-${uuid}`;
  return `package-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function normalizeCaptureQuality(value) {
  const quality = Number(value);
  if (!Number.isFinite(quality)) return 0;
  return Math.max(0, Math.min(1, quality));
}

function normalizeNativeResult(payload, captureQuality, modelInfo, capturedAt) {
  if (Number(payload?.schemaVersion) !== PACKAGE_ANALYZER_SCHEMA_VERSION) {
    return failedAnalysis('unsupported-schema', captureQuality);
  }

  const analysis = normalizePackageAnalysis({ ...payload, capturedAt });
  if (analysis.status === PACKAGE_ANALYSIS_STATUSES.READY) {
    const verifiedModel = modelInfo?.schemaVersion === PACKAGE_ANALYZER_SCHEMA_VERSION
      && modelInfo.modelAvailable === true
      && Boolean(modelInfo.modelVersion)
      && modelInfo.modelVersion === analysis.modelVersion
      && Boolean(modelInfo.modelSha256)
      && modelInfo.modelSha256 === analysis.modelSha256;
    if (verifiedModel && canOpenDoorFromPackageAnalysis(analysis)) return analysis;
    return normalizePackageAnalysis({
      ...analysis,
      status: PACKAGE_ANALYSIS_STATUSES.UNCERTAIN,
      suggestedSize: '',
      confidence: null,
      reasonCode: verifiedModel ? 'unsafe-analysis-result' : 'unverified-model-result',
    });
  }

  return normalizePackageAnalysis({
    ...analysis,
    suggestedSize: '',
    confidence: null,
  });
}

export function getLocalPackageAnalyzerInfo(options = {}) {
  const runtime = options.runtime ?? (typeof window !== 'undefined' ? window : globalThis);
  const bridge = options.bridge ?? runtime.PredditaPackageAnalyzer;
  if (!bridge?.getInfo) {
    return {
      schemaVersion: PACKAGE_ANALYZER_SCHEMA_VERSION,
      bridgeVersion: '',
      modelVersion: '',
      modelAvailable: false,
      modelSha256: '',
      reasonCode: 'analyzer-unavailable',
    };
  }

  try {
    const rawInfo = bridge.getInfo();
    const info = typeof rawInfo === 'string' ? JSON.parse(rawInfo) : rawInfo;
    return {
      schemaVersion: Number(info?.schemaVersion) || 0,
      bridgeVersion: String(info?.bridgeVersion ?? '').slice(0, 80),
      modelVersion: String(info?.modelVersion ?? '').slice(0, 80),
      modelAvailable: info?.modelAvailable === true,
      modelSha256: /^[a-f0-9]{64}$/i.test(String(info?.modelSha256 ?? ''))
        ? String(info.modelSha256).toLowerCase()
        : '',
      reasonCode: String(info?.reasonCode ?? '').slice(0, 80),
    };
  } catch (_error) {
    return {
      schemaVersion: PACKAGE_ANALYZER_SCHEMA_VERSION,
      bridgeVersion: '',
      modelVersion: '',
      modelAvailable: false,
      modelSha256: '',
      reasonCode: 'invalid-analyzer-info',
    };
  }
}

export function analyzePackagePhoto(input = {}, options = {}) {
  const runtime = options.runtime ?? (typeof window !== 'undefined' ? window : globalThis);
  const eventTarget = options.eventTarget ?? runtime;
  const bridge = options.bridge ?? runtime.PredditaPackageAnalyzer;
  const captureQuality = normalizeCaptureQuality(input.captureQuality);
  const photoDataUrl = String(input.photoDataUrl ?? '').trim();

  if (
    !photoDataUrl.startsWith('data:image/jpeg;base64,')
      || photoDataUrl.length > PACKAGE_ANALYZER_MAX_IMAGE_CHARS
  ) {
    return Promise.resolve(failedAnalysis('invalid-image', captureQuality));
  }
  if (!bridge?.analyze || !eventTarget?.addEventListener || !eventTarget?.removeEventListener) {
    return Promise.resolve(failedAnalysis('analyzer-unavailable', captureQuality));
  }

  const requestId = createRequestId(runtime);
  const request = {
    schemaVersion: PACKAGE_ANALYZER_SCHEMA_VERSION,
    requestId,
    photoDataUrl,
    capturedAt: String(input.capturedAt ?? '').slice(0, 40),
    captureQuality,
  };
  const requestedTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(1, Math.min(15_000, Math.round(requestedTimeout)))
    : PACKAGE_ANALYZER_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (analysis) => {
      if (settled) return;
      settled = true;
      eventTarget.removeEventListener(PACKAGE_ANALYZER_EVENT, handleResult);
      runtime.clearTimeout(timer);
      resolve(analysis);
    };
    const handleResult = (event) => {
      try {
        const payload = typeof event?.detail === 'string'
          ? JSON.parse(event.detail)
          : event?.detail;
        if (payload?.requestId !== requestId) return;
        finish(normalizeNativeResult(
          payload,
          captureQuality,
          getLocalPackageAnalyzerInfo({ bridge, runtime }),
          request.capturedAt,
        ));
      } catch (_error) {
        finish(failedAnalysis('invalid-analyzer-result', captureQuality));
      }
    };
    const timer = runtime.setTimeout(
      () => finish(failedAnalysis('analyzer-timeout', captureQuality)),
      timeoutMs,
    );

    eventTarget.addEventListener(PACKAGE_ANALYZER_EVENT, handleResult);
    try {
      const accepted = bridge.analyze(JSON.stringify(request));
      if (accepted === false) finish(failedAnalysis('analyzer-busy', captureQuality));
    } catch (_error) {
      finish(failedAnalysis('analyzer-error', captureQuality));
    }
  });
}
