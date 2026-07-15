import assert from 'node:assert/strict';
import {
  REMOTE_COMMAND_EXECUTIONS_STORAGE_KEY,
  loadRemoteCommandExecutions,
  saveRemoteCommandExecutions,
  updateRemoteCommandExecution,
  upsertRemoteCommandExecution,
} from '../web/src/remoteCommandJournal.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

const storage = new MemoryStorage();
const first = upsertRemoteCommandExecution([], {
  id: 'cmd-test-1',
  door: 4,
  leaseId: 'lease-1',
  deliveryAttempt: 1,
}, '2026-07-15T12:00:00.000Z');

assert.equal(first.execution.status, 'received');
assert.equal(first.execution.leaseId, 'lease-1');
assert.ok(first.execution.executionId.startsWith('exec-cmd-test-1-'));

saveRemoteCommandExecutions(first.records, storage);
assert.ok(storage.getItem(REMOTE_COMMAND_EXECUTIONS_STORAGE_KEY));
const restored = loadRemoteCommandExecutions(storage);
assert.equal(restored.length, 1);
assert.equal(restored[0].executionId, first.execution.executionId);

const retried = upsertRemoteCommandExecution(restored, {
  id: 'cmd-test-1',
  door: 4,
  leaseId: 'lease-2',
  deliveryAttempt: 2,
}, '2026-07-15T12:00:01.000Z');
assert.equal(retried.execution.executionId, first.execution.executionId);
assert.equal(retried.execution.leaseId, 'lease-2');
assert.equal(retried.execution.status, 'received');

const executing = updateRemoteCommandExecution(retried.records, 'cmd-test-1', {
  status: 'executing',
  executingAt: '2026-07-15T12:00:02.000Z',
});
assert.equal(executing.execution.status, 'executing');

const afterRestart = upsertRemoteCommandExecution(executing.records, {
  id: 'cmd-test-1',
  door: 4,
  leaseId: 'lease-3',
  executionId: first.execution.executionId,
  deliveryAttempt: 3,
});
assert.equal(afterRestart.execution.status, 'executing');
assert.equal(afterRestart.conflict, false);

const conflict = upsertRemoteCommandExecution(afterRestart.records, {
  id: 'cmd-test-1',
  door: 4,
  leaseId: 'lease-4',
  executionId: 'exec-servidor-divergente',
  deliveryAttempt: 4,
});
assert.equal(conflict.conflict, true);
assert.equal(conflict.execution.status, 'unknown');
assert.equal(conflict.execution.executionId, 'exec-servidor-divergente');

const completion = {
  ok: false,
  executionId: conflict.execution.executionId,
  executionOutcomeUnknown: true,
};
const completed = updateRemoteCommandExecution(conflict.records, 'cmd-test-1', {
  status: 'completed',
  result: completion,
  completedAt: '2026-07-15T12:00:03.000Z',
});
assert.deepEqual(completed.execution.result, completion);
assert.equal(completed.execution.status, 'completed');

console.log('PREDDITA_V2_REMOTE_COMMAND_JOURNAL_OK');
