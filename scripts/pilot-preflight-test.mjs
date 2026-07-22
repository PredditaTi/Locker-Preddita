import assert from 'node:assert/strict';
import { evaluatePilotReadiness } from './pilotReadiness.mjs';

function readyState() {
  return {
    runtime: { deviceFresh: true, deviceAuthMode: 'hmac' },
    device: {
      online: true,
      serialOpen: true,
      serialPath: '/dev/ttyS5',
      lastSeenAt: '2026-07-21T12:00:00.000Z',
      commissioningStatus: 'complete',
      commissionedAt: '2026-07-21T11:00:00.000Z',
      doorCount: 3,
      appUpdater: {
        currentVersionName: '2.0.31-lab',
        status: 'healthy',
        health: { credentialAvailable: true },
      },
    },
    appUpdate: {
      enabled: true,
      channel: 'pilot',
      rolloutPercentage: 10,
      autoPausedAt: '',
    },
    doors: [{ channel: 1 }, { channel: 2 }, { channel: 3 }],
  };
}

const ready = evaluatePilotReadiness(readyState(), {
  expectedVersion: '2.0.31-lab',
  checkedAt: '2026-07-21T12:01:00.000Z',
});
assert.equal(ready.ready, true);
assert.equal(ready.blockingCount, 0);

const blockedState = readyState();
blockedState.device.serialOpen = false;
blockedState.device.commissioningStatus = 'pending';
blockedState.device.appUpdater.currentVersionName = '2.0.25-lab';
blockedState.appUpdate.channel = 'production';
blockedState.appUpdate.rolloutPercentage = 100;
blockedState.appUpdate.autoPausedAt = '2026-07-21T12:02:00.000Z';
const blocked = evaluatePilotReadiness(blockedState, { expectedVersion: '2.0.31-lab' });
assert.equal(blocked.ready, false);
assert.deepEqual(
  blocked.checks.filter((check) => !check.ok).map((check) => check.id),
  ['serial-open', 'commissioned', 'candidate-version', 'rollout-scope', 'rollout-health'],
);

console.log('Pilot preflight tests passed.');
