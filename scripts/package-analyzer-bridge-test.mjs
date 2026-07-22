import assert from 'node:assert/strict';

import {
  PACKAGE_ANALYZER_EVENT,
  analyzePackagePhoto,
  getLocalPackageAnalyzerInfo,
} from '../web/src/packageAnalyzer.js';

const PHOTO = 'data:image/jpeg;base64,AA==';

function createRuntime() {
  const eventTarget = new EventTarget();
  return {
    eventTarget,
    runtime: {
      crypto: { randomUUID: () => 'test-request-id' },
      setTimeout,
      clearTimeout,
    },
  };
}

function dispatchResult(eventTarget, detail) {
  const event = new Event(PACKAGE_ANALYZER_EVENT);
  Object.defineProperty(event, 'detail', { value: detail });
  eventTarget.dispatchEvent(event);
}

{
  const { eventTarget, runtime } = createRuntime();
  let capturedRequest = null;
  const bridge = {
    getInfo() {
      return JSON.stringify({
        schemaVersion: 1,
        bridgeVersion: 'PREDDITA-PACKAGE-ANALYZER-TEST',
        modelVersion: 'package-pg-v1',
        modelAvailable: true,
        modelSha256: 'a'.repeat(64),
        reasonCode: '',
      });
    },
    analyze(rawRequest) {
      capturedRequest = JSON.parse(rawRequest);
      queueMicrotask(() => dispatchResult(eventTarget, {
        schemaVersion: 1,
        requestId: capturedRequest.requestId,
        status: 'ready',
        suggestedSize: 'P',
        confidence: 0.96,
        captureQuality: capturedRequest.captureQuality,
        modelVersion: 'package-pg-v1',
        modelSha256: 'a'.repeat(64),
        inferenceMs: 80,
        reasonCode: '',
      }));
      return true;
    },
  };

  const analysis = await analyzePackagePhoto(
    { photoDataUrl: PHOTO, capturedAt: '2026-07-22T12:00:00.000Z', captureQuality: 0.88 },
    { bridge, eventTarget, runtime },
  );
  assert.equal(analysis.status, 'ready');
  assert.equal(analysis.suggestedSize, 'P');
  assert.equal(analysis.confidence, 0.96);
  assert.equal(analysis.modelSha256, 'a'.repeat(64));
  assert.deepEqual(Object.keys(capturedRequest).sort(), [
    'captureQuality',
    'capturedAt',
    'photoDataUrl',
    'requestId',
    'schemaVersion',
  ]);
  assert.equal('channel' in capturedRequest, false, 'analyzer request must never contain a door channel');
  assert.equal('board' in capturedRequest, false, 'analyzer request must never contain a serial board');
}

{
  const { eventTarget, runtime } = createRuntime();
  const bridge = {
    getInfo: () => JSON.stringify({
      schemaVersion: 1,
      modelVersion: 'package-pg-v1',
      modelAvailable: true,
      modelSha256: 'b'.repeat(64),
    }),
    analyze(rawRequest) {
      const request = JSON.parse(rawRequest);
      queueMicrotask(() => dispatchResult(eventTarget, {
        schemaVersion: 1,
        requestId: request.requestId,
        status: 'ready',
        suggestedSize: 'P',
        confidence: 0.99,
        modelVersion: 'package-pg-v1',
        modelSha256: 'a'.repeat(64),
      }));
      return true;
    },
  };
  const analysis = await analyzePackagePhoto(
    { photoDataUrl: PHOTO, captureQuality: 0.9 },
    { bridge, eventTarget, runtime },
  );
  assert.equal(analysis.status, 'uncertain');
  assert.equal(analysis.reasonCode, 'unverified-model-result');
}

{
  const { eventTarget, runtime } = createRuntime();
  const bridge = {
    getInfo: () => JSON.stringify({
      schemaVersion: 1,
      modelVersion: 'package-pg-v1',
      modelAvailable: true,
      modelSha256: 'a'.repeat(64),
    }),
    analyze(rawRequest) {
      const request = JSON.parse(rawRequest);
      queueMicrotask(() => dispatchResult(eventTarget, {
        schemaVersion: 1,
        requestId: request.requestId,
        status: 'ready',
        suggestedSize: 'G',
        confidence: 0.72,
        modelVersion: 'package-pg-v1',
        modelSha256: 'a'.repeat(64),
        reasonCode: '',
      }));
      return true;
    },
  };
  const analysis = await analyzePackagePhoto(
    { photoDataUrl: PHOTO, captureQuality: 0.9 },
    { bridge, eventTarget, runtime },
  );
  assert.equal(analysis.status, 'uncertain');
  assert.equal(analysis.suggestedSize, '');
  assert.equal(analysis.confidence, null);
  assert.equal(analysis.reasonCode, 'unsafe-analysis-result');
}

{
  const { eventTarget, runtime } = createRuntime();
  const unavailable = await analyzePackagePhoto(
    { photoDataUrl: PHOTO, captureQuality: 0.9 },
    { bridge: null, eventTarget, runtime },
  );
  assert.equal(unavailable.status, 'failed');
  assert.equal(unavailable.reasonCode, 'analyzer-unavailable');

  const busy = await analyzePackagePhoto(
    { photoDataUrl: PHOTO, captureQuality: 0.9 },
    { bridge: { analyze: () => false }, eventTarget, runtime },
  );
  assert.equal(busy.reasonCode, 'analyzer-busy');

  const timedOut = await analyzePackagePhoto(
    { photoDataUrl: PHOTO, captureQuality: 0.9 },
    { bridge: { analyze: () => true }, eventTarget, runtime, timeoutMs: 5 },
  );
  assert.equal(timedOut.reasonCode, 'analyzer-timeout');
}

{
  const info = getLocalPackageAnalyzerInfo({
    bridge: {
      getInfo: () => JSON.stringify({
        schemaVersion: 1,
        bridgeVersion: 'PREDDITA-PACKAGE-ANALYZER-1.0.0',
        modelVersion: 'package-pg-v1',
        modelAvailable: false,
        modelSha256: 'not-a-checksum',
        reasonCode: 'model-not-installed',
      }),
    },
  });
  assert.equal(info.modelAvailable, false);
  assert.equal(info.modelSha256, '');
  assert.equal(info.reasonCode, 'model-not-installed');
}

console.log('Package analyzer bridge tests passed.');
