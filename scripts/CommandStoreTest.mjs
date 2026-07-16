import assert from 'node:assert/strict';
import {
  COMMAND_SCHEMA_VERSION,
  COMMAND_TRANSACTION_RETRY_ATTEMPTS,
  reconcileOperationalCommand,
} from '../admin-online/commandStore.mjs';

const nowMs = Date.parse('2026-07-15T15:00:00.000Z');
const base = {
  id: 'command-1',
  type: 'openDoor',
  door: 4,
  status: 'leased',
  leaseId: 'lease-1',
  executionId: '',
  createdAt: '2026-07-15T14:59:30.000Z',
  leaseExpiresAt: '2026-07-15T14:59:59.000Z',
  timeline: [],
};

assert.equal(COMMAND_SCHEMA_VERSION, 1);
assert.equal(COMMAND_TRANSACTION_RETRY_ATTEMPTS, 3);

const released = reconcileOperationalCommand(base, { nowMs, commandTtlMs: 120_000 });
assert.equal(released.changed, true);
assert.equal(released.change, 'lease-expired');
assert.equal(released.command.status, 'pending');
assert.equal(released.command.leaseId, '');
assert.equal(released.releasedLeaseCount, 1);

const executing = {
  ...base,
  status: 'executing',
  executionId: 'execution-command-1',
};
const executionReleased = reconcileOperationalCommand(executing, { nowMs, commandTtlMs: 120_000 });
assert.equal(executionReleased.command.status, 'pending');
assert.equal(executionReleased.command.executionId, 'execution-command-1');
assert.match(executionReleased.command.timeline.at(-1).detail, /reconciliacao idempotente/);

const expired = reconcileOperationalCommand(
  { ...executing, createdAt: '2026-07-15T14:55:00.000Z' },
  { nowMs, commandTtlMs: 120_000 }
);
assert.equal(expired.change, 'expired');
assert.equal(expired.command.status, 'failed');
assert.equal(expired.command.result.expired, true);
assert.equal(expired.command.result.executionId, 'execution-command-1');
assert.equal(expired.expiredCount, 1);

const terminal = reconcileOperationalCommand(
  { ...base, status: 'completed', completedAt: '2026-07-15T14:59:50.000Z' },
  { nowMs, commandTtlMs: 1 }
);
assert.equal(terminal.changed, false);
assert.equal(terminal.command.status, 'completed');

console.log('PREDDITA_COMMAND_STORE_OK');
