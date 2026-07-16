import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { EdgeAgentRuntime, EDGE_AGENT_CONTRACT_VERSION } from '../web/src/edgeAgent.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  get length() {
    return this.values.size;
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(String(key));
  }
}

function createHardware() {
  return {
    isNative: () => false,
    getHardwareInfo: () => ({ serialOpen: true, bridgeVersion: 'TEST' }),
    readAll: async () => ({ ok: true }),
    readStatus: async () => ({ ok: true }),
    setTimeout: async () => ({ ok: true }),
    unlock: async () => ({ ok: true }),
    close: async () => ({ ok: true }),
    firmware: async () => ({ ok: true, hex: '82 01 00 AB 28' }),
  };
}

function createRemote(overrides = {}) {
  return {
    getNativeDeviceAuthStatus: () => ({ available: false, provisioned: false }),
    openNativeDeviceProvisioning: () => false,
    fetchRemoteSnapshot: async () => ({ residents: [], commands: [] }),
    publishRemoteStatus: async () => true,
    publishRemoteEvents: async (events) => ({
      ok: true,
      acceptedIds: events.map((event) => event.id),
      notifications: [],
    }),
    acknowledgeRemoteCommand: async () => ({ terminal: false }),
    completeRemoteCommand: async () => ({ ok: true }),
    mapRemoteResidentToRecipient: (resident) => ({
      id: resident.id,
      apartment: resident.apartment,
    }),
    ...overrides,
  };
}

async function testOfflineEventRecovery() {
  const storage = new MemoryStorage();
  const offlineAgent = new EdgeAgentRuntime({
    storage,
    hardware: createHardware(),
    remote: createRemote({ publishRemoteEvents: async () => null }),
  });

  offlineAgent.queueEvent('delivery-stored', { delivery: { id: 'delivery-1' } }, {
    id: 'edge-delivery-stored-delivery-1',
  });
  assert.equal(await offlineAgent.flushPendingEvents(), false);
  assert.equal(offlineAgent.pendingEvents[0].attempts, 1);

  let notifications = [];
  const recoveredAgent = new EdgeAgentRuntime({
    storage,
    hardware: createHardware(),
    remote: createRemote({
      publishRemoteEvents: async (events) => ({
        ok: true,
        acceptedIds: events.map((event) => event.id),
        notifications: [{ deliveryId: 'delivery-1', notification: { status: 'sent' } }],
      }),
    }),
  });
  assert.equal(recoveredAgent.pendingEvents.length, 1);
  assert.equal(await recoveredAgent.flushPendingEvents({
    onNotifications: (items) => { notifications = items; },
  }), true);
  assert.equal(recoveredAgent.pendingEvents.length, 0);
  assert.equal(notifications[0].notification.status, 'sent');
}

async function testOperationalStateStorage() {
  const storage = new MemoryStorage();
  const agent = new EdgeAgentRuntime({ storage, hardware: createHardware(), remote: createRemote() });
  const initialState = agent.loadLockerState();
  const persistedState = {
    ...initialState,
    tenant: { ...initialState.tenant, id: 'tenant-edge-test' },
  };
  agent.persistLockerState(persistedState);

  const recovered = new EdgeAgentRuntime({ storage, hardware: createHardware(), remote: createRemote() });
  assert.equal(recovered.loadLockerState().tenant.id, 'tenant-edge-test');
}

async function testIdempotentRemoteCommand() {
  const storage = new MemoryStorage();
  const completed = [];
  let acknowledged = 0;
  let opened = 0;
  let residents = [];
  const command = {
    id: 'command-1',
    type: 'openDoor',
    door: 4,
    leaseId: 'lease-1',
    deliveryAttempt: 1,
  };
  const remote = createRemote({
    fetchRemoteSnapshot: async () => ({
      residentsUpdatedAt: '2026-07-15T12:00:00.000Z',
      residents: [{ id: 'resident-1', apartment: '101', updatedAt: '2026-07-15T11:00:00.000Z' }],
      commands: [command],
    }),
    acknowledgeRemoteCommand: async () => {
      acknowledged += 1;
      return { terminal: false };
    },
    completeRemoteCommand: async (commandId, result) => {
      completed.push({ commandId, result });
      return { ok: true };
    },
  });
  const agent = new EdgeAgentRuntime({ storage, hardware: createHardware(), remote });
  const options = {
    doorCount: 8,
    status: { device: { edgeAppVersion: 'test' } },
    onResidents: (items) => { residents = items; },
    onOpenDoor: async ({ door }) => {
      opened += 1;
      return {
        ok: true,
        confirmed: true,
        reason: 'physical-cycle-opened',
        pendingPhysicalClose: true,
        physicalOpenCycle: { channel: door },
      };
    },
  };

  assert.equal((await agent.runRemoteCycle(options)).ok, true);
  assert.equal((await agent.runRemoteCycle(options)).ok, true);
  assert.equal(opened, 1, 'replay must not actuate the same command twice');
  assert.equal(acknowledged, 1, 'completed replay must not request a new ACK');
  assert.equal(completed.length, 2, 'completion is safely replayed until server stops delivering the command');
  assert.equal(completed[0].result.executionId.startsWith('exec-command-1-'), true);
  assert.equal(completed[0].result.pendingPhysicalClose, true);
  assert.deepEqual(residents, [{ id: 'resident-1', apartment: '101' }]);
}

async function testUnknownExecutionAfterRestart() {
  const storage = new MemoryStorage();
  const command = { id: 'command-restart', type: 'openDoor', door: 2, leaseId: 'lease-restart' };
  const seed = new EdgeAgentRuntime({ storage, hardware: createHardware(), remote: createRemote() });
  seed.registerCommand(command);
  seed.updateCommand(command.id, { status: 'executing', executingAt: '2026-07-15T12:00:00.000Z' });

  let opened = 0;
  let completion = null;
  const recovered = new EdgeAgentRuntime({
    storage,
    hardware: createHardware(),
    remote: createRemote({
      fetchRemoteSnapshot: async () => ({ residents: [], commands: [command] }),
      completeRemoteCommand: async (_commandId, result) => {
        completion = result;
        return { ok: true };
      },
    }),
  });
  await recovered.runRemoteCycle({
    doorCount: 8,
    onOpenDoor: async () => {
      opened += 1;
      return { ok: true };
    },
  });

  assert.equal(opened, 0, 'an execution interrupted by restart must never be repeated automatically');
  assert.equal(completion.executionOutcomeUnknown, true);
  assert.equal(completion.reason, 'execution-outcome-unknown');
}

async function testConcurrentCycles() {
  let releaseSnapshot;
  const snapshotGate = new Promise((resolve) => { releaseSnapshot = resolve; });
  const agent = new EdgeAgentRuntime({
    storage: new MemoryStorage(),
    hardware: createHardware(),
    remote: createRemote({ fetchRemoteSnapshot: () => snapshotGate }),
  });

  const first = agent.runRemoteCycle({ doorCount: 8, onOpenDoor: async () => ({ ok: true }) });
  const second = await agent.runRemoteCycle({ doorCount: 8, onOpenDoor: async () => ({ ok: true }) });
  assert.deepEqual(second, { ok: false, skipped: 'already-running' });
  releaseSnapshot({ residents: [], commands: [] });
  assert.equal((await first).ok, true);
}

async function testKioskBoundary() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'src');
  const kioskModules = ['App.jsx', 'CommissioningPanel.jsx', 'DiagnosticsView.jsx', 'diagnostics.js'];
  for (const file of kioskModules) {
    const source = await readFile(join(root, file), 'utf8');
    assert.equal(source.includes("from './serial.js'"), false, `${file} bypasses Edge Agent hardware contract`);
    assert.equal(source.includes("from './remoteBridge.js'"), false, `${file} bypasses Edge Agent remote contract`);
  }
}

assert.equal(EDGE_AGENT_CONTRACT_VERSION, 1);
await testOfflineEventRecovery();
await testOperationalStateStorage();
await testIdempotentRemoteCommand();
await testUnknownExecutionAfterRestart();
await testConcurrentCycles();
await testKioskBoundary();

console.log('PASS Edge Agent contract, offline recovery, idempotency and kiosk boundary');
