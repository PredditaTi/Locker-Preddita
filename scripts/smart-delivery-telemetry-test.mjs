import assert from 'node:assert/strict';

import {
  MAX_SMART_DELIVERY_TELEMETRY_EVENTS,
  SMART_DELIVERY_TELEMETRY_STORAGE_KEY,
  clearSmartDeliveryTelemetry,
  getSmartDeliveryTelemetrySummary,
  recordSmartDeliveryTelemetry,
} from '../web/src/smartDeliveryTelemetry.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

const storage = new MemoryStorage();
const now = '2026-07-22T12:00:00.000Z';
const recorded = recordSmartDeliveryTelemetry({
  action: 'analysis',
  outcome: 'ready',
  size: 'P',
  captureQuality: 0.92,
  inferenceMs: 187,
  modelVersion: 'package-pg-v1',
  apartment: '203',
  photoDataUrl: 'data:image/jpeg;base64,SECRET',
  trackingCode: 'TRACK-123',
}, { storage, occurredAt: now });
assert.deepEqual(recorded, {
  action: 'analysis',
  outcome: 'ready',
  size: 'P',
  reasonCode: 'none',
  captureQualityBand: 'high',
  inferenceMs: 190,
  modelVersion: 'package-pg-v1',
  occurredAt: now,
});
const serialized = storage.getItem(SMART_DELIVERY_TELEMETRY_STORAGE_KEY);
for (const forbidden of ['apartment', 'photoDataUrl', 'trackingCode', 'SECRET', '203']) {
  assert.equal(serialized.includes(forbidden), false, `${forbidden} nao pode ser persistido`);
}
assert.equal(recordSmartDeliveryTelemetry({
  action: 'analysis',
  outcome: 'opened',
}, { storage, occurredAt: now }), null, 'resultado deve pertencer a acao informada');

recordSmartDeliveryTelemetry({
  action: 'analysis',
  outcome: 'uncertain',
  reasonCode: 'model-not-installed',
}, { storage, occurredAt: '2026-07-22T12:01:00.000Z' });
recordSmartDeliveryTelemetry({
  action: 'recommendation',
  outcome: 'confirmed',
  size: 'P',
}, { storage, occurredAt: '2026-07-22T12:02:00.000Z' });
recordSmartDeliveryTelemetry({
  action: 'allocation',
  outcome: 'opened',
  size: 'P',
}, { storage, occurredAt: '2026-07-22T12:03:00.000Z' });

const summary = getSmartDeliveryTelemetrySummary({
  storage,
  nowMs: Date.parse('2026-07-22T12:04:00.000Z'),
});
assert.equal(summary.eventCount, 4);
assert.equal(summary.analysisCount, 2);
assert.equal(summary.readyPCount, 1);
assert.equal(summary.uncertainCount, 1);
assert.equal(summary.recommendationConfirmedCount, 1);
assert.equal(summary.openedCount, 1);
assert.equal(summary.inferenceP95Ms, 190);

const withExpired = JSON.parse(storage.getItem(SMART_DELIVERY_TELEMETRY_STORAGE_KEY));
withExpired.events.push({
  action: 'analysis',
  outcome: 'failed',
  size: '',
  reasonCode: 'none',
  captureQualityBand: 'unknown',
  inferenceMs: 0,
  modelVersion: '',
  occurredAt: '2026-07-01T12:00:00.000Z',
});
storage.setItem(SMART_DELIVERY_TELEMETRY_STORAGE_KEY, JSON.stringify(withExpired));
assert.equal(getSmartDeliveryTelemetrySummary({
  storage,
  nowMs: Date.parse('2026-07-22T12:04:00.000Z'),
}).failedCount, 0, 'evento fora da retencao deve ser descartado');

for (let index = 0; index < MAX_SMART_DELIVERY_TELEMETRY_EVENTS + 10; index += 1) {
  recordSmartDeliveryTelemetry({ action: 'analysis', outcome: 'uncertain' }, {
    storage,
    occurredAt: new Date(Date.parse(now) + index * 1000).toISOString(),
  });
}
assert.equal(getSmartDeliveryTelemetrySummary({
  storage,
  nowMs: Date.parse('2026-07-22T13:00:00.000Z'),
}).eventCount, MAX_SMART_DELIVERY_TELEMETRY_EVENTS);
assert.equal(clearSmartDeliveryTelemetry({ storage }), true);
assert.equal(storage.getItem(SMART_DELIVERY_TELEMETRY_STORAGE_KEY), null);

console.log('Smart delivery telemetry tests passed.');
