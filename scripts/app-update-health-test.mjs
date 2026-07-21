import assert from 'node:assert/strict';

import {
  APP_UPDATE_CONFIGURATION_BACKUP_KEY,
  saveAppUpdateConfigurationBackup,
  validateAppUpdateConfigurationBackup,
} from '../web/src/appUpdateHealth.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }
}

function createState() {
  return {
    tenant: { id: 'tenant-test', lockerId: 'locker-test', name: 'Nao deve entrar no backup' },
    deviceConfig: {
      board: 1,
      doorCount: 4,
      sensorPolarity: 'zeroClosed',
      unlockTimeoutSeconds: 3,
      doorSizes: ['G', 'M', 'P', 'P'],
      commissioning: { status: 'complete', completedAt: '2026-07-21T12:00:00.000Z' },
    },
    recipients: [{ id: 'resident-1', email: 'private@example.com' }],
    deliveries: [{ id: 'delivery-1', pin: '123456', token: 'secret-token' }],
  };
}

const storage = new MemoryStorage();
const manifest = { releaseId: 'v2.0.26-lab', versionCode: 26 };
const saved = saveAppUpdateConfigurationBackup({
  storage,
  state: createState(),
  manifest,
  now: () => '2026-07-21T12:30:00.000Z',
});
assert.equal(saved.ok, true);

const serialized = storage.getItem(APP_UPDATE_CONFIGURATION_BACKUP_KEY);
assert.ok(serialized);
assert.equal(serialized.includes('private@example.com'), false);
assert.equal(serialized.includes('123456'), false);
assert.equal(serialized.includes('secret-token'), false);
assert.equal(serialized.includes('recipients'), false);
assert.equal(serialized.includes('deliveries'), false);

const valid = validateAppUpdateConfigurationBackup({
  storage,
  state: createState(),
  updaterStatus: { releaseId: manifest.releaseId, targetVersionCode: manifest.versionCode },
});
assert.deepEqual(valid, { checked: true, valid: true, errorCode: '' });

const incompatibleState = createState();
incompatibleState.deviceConfig.doorCount = 3;
incompatibleState.deviceConfig.doorSizes = ['G', 'M', 'P'];
const incompatible = validateAppUpdateConfigurationBackup({
  storage,
  state: incompatibleState,
  updaterStatus: { releaseId: manifest.releaseId, targetVersionCode: manifest.versionCode },
});
assert.equal(incompatible.valid, false);
assert.equal(incompatible.errorCode, 'CONFIGURATION_BACKUP_INCOMPATIBLE');

storage.setItem(APP_UPDATE_CONFIGURATION_BACKUP_KEY, '{invalid-json');
const unreadable = validateAppUpdateConfigurationBackup({
  storage,
  state: createState(),
  updaterStatus: { releaseId: manifest.releaseId, targetVersionCode: manifest.versionCode },
});
assert.equal(unreadable.errorCode, 'CONFIGURATION_BACKUP_READ_FAILED');

console.log('PASS app update configuration health contract');
