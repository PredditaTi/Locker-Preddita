import assert from 'node:assert/strict';
import {
  PILOT_JOURNEY_STORAGE_KEY,
  completePilotJourney,
  recoverInterruptedPilotJourney,
  recordPilotJourneySignal,
  startPilotJourney,
} from '../web/src/pilotMetrics.js';
import {
  MAX_PILOT_METRICS,
  normalizePilotMetric,
  recordPilotMetric,
  summarizePilotMetrics,
} from '../admin-online/pilotMetrics.mjs';

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
const startedAt = '2026-07-21T12:00:00.000Z';
const started = startPilotJourney({ storage, journeyType: 'courier', startedAt });
assert.equal(started.journey.journeyType, 'courier');
assert.equal(started.interruptedMetric, null);

recordPilotJourneySignal({ storage, signal: 'help' });
recordPilotJourneySignal({ storage, signal: 'size-fallback' });
recordPilotJourneySignal({ storage, signal: 'error' });
const completed = completePilotJourney({
  storage,
  outcome: 'completed',
  occurredAt: '2026-07-21T12:02:05.000Z',
});
assert.deepEqual(completed.payload, {
  schemaVersion: 1,
  journeyType: 'courier',
  outcome: 'completed',
  durationMs: 125000,
  pickupMode: 'none',
  usedSizeFallback: true,
  helpRequested: true,
  errorCount: 1,
  reasonCode: 'none',
});
assert.equal(storage.getItem(PILOT_JOURNEY_STORAGE_KEY), null);

startPilotJourney({ storage, journeyType: 'pickup', startedAt: '2026-07-21T13:00:00.000Z' });
recordPilotJourneySignal({ storage, signal: 'pickup-mode', pickupMode: 'qr' });
const interrupted = recoverInterruptedPilotJourney({
  storage,
  occurredAt: '2026-07-21T13:01:00.000Z',
});
assert.equal(interrupted.payload.outcome, 'interrupted');
assert.equal(interrupted.payload.pickupMode, 'qr');
assert.equal(interrupted.payload.reasonCode, 'app-restarted');

const sanitized = normalizePilotMetric({
  ...completed.payload,
  apartment: '203',
  pin: '123456',
  qrPayload: 'preddita://secret',
  door: 7,
  message: 'texto livre',
  pickupMode: 'pin',
}, {
  id: completed.id,
  occurredAt: completed.occurredAt,
});
assert.equal('apartment' in sanitized, false);
assert.equal('pin' in sanitized, false);
assert.equal('qrPayload' in sanitized, false);
assert.equal('door' in sanitized, false);
assert.equal('message' in sanitized, false);
assert.equal(sanitized.pickupMode, 'none');

let pilot = recordPilotMetric({}, completed.payload, {
  id: completed.id,
  occurredAt: completed.occurredAt,
});
pilot.metrics[0].receivedAt = '2026-07-21T12:02:06.000Z';
pilot = recordPilotMetric(pilot, interrupted.payload, {
  id: interrupted.id,
  occurredAt: interrupted.occurredAt,
});
const summary = summarizePilotMetrics(pilot);
assert.equal(summary.sampleCount, 2);
assert.equal(summary.completedCount, 1);
assert.equal(summary.interruptedCount, 1);
assert.equal(summary.helpRequestCount, 1);
assert.equal(summary.fallbackCount, 1);
assert.equal(summary.errorCount, 1);
assert.equal(summary.medianDurationMs, 60000);
assert.equal(summary.p95DurationMs, 125000);
assert.equal(
  pilot.metrics.find((metric) => metric.eventId === completed.id)?.receivedAt,
  '2026-07-21T12:02:06.000Z',
);

for (let index = 0; index < MAX_PILOT_METRICS + 10; index += 1) {
  pilot = recordPilotMetric(pilot, completed.payload, {
    id: `bounded-${index}`,
    occurredAt: completed.occurredAt,
  });
}
assert.equal(pilot.metrics.length, MAX_PILOT_METRICS);

console.log('Pilot metrics tests passed.');
