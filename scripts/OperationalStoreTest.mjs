import assert from 'node:assert/strict';
import {
  OPERATIONAL_SCHEMA_VERSION,
  buildOperationalRows,
  persistOperationalStateInTransaction,
  splitOperationalState,
} from '../admin-online/operationalStore.mjs';

const state = {
  schemaVersion: 8,
  tenant: { tenantId: 'tenant-test', lockerId: 'locker-test' },
  device: { online: true },
  notificationOutbox: [{ id: 'mail-1' }],
  residents: [{
    id: 'resident-1',
    apartment: '101',
    building: 'Torre A',
    floor: '1',
    phone: '11999990000',
    email: 'MORADOR@EXAMPLE.COM',
    createdAt: '2026-07-15T12:00:00.000Z',
    updatedAt: '2026-07-15T12:30:00.000Z',
  }],
  deliveries: [{
    id: 'delivery-1',
    recipientId: 'resident-1',
    recipientEmail: 'MORADOR@EXAMPLE.COM',
    unit: 'Torre A - Ap 101',
    door: '3',
    size: 'P',
    status: 'stored',
    createdAt: '2026-07-15T13:00:00.000Z',
    depositedAt: 'data-invalida',
  }],
  commands: [{
    id: 'command-1',
    type: 'openDoor',
    status: 'pending',
    door: 3,
    leaseId: 'lease-command-1',
    executionId: '',
    deliveryAttempt: 2,
    createdAt: '2026-07-15T13:05:00.000Z',
    acknowledgedAt: '2026-07-15T13:06:00.000Z',
  }],
  auditTrail: [{
    id: 'audit-1',
    kind: 'delivery-stored',
    message: 'Entrega guardada.',
    meta: { deliveryId: 'delivery-1' },
    at: '2026-07-15T13:00:00.000Z',
  }],
};

const { coreState, operationalData } = splitOperationalState(state);
assert.equal(OPERATIONAL_SCHEMA_VERSION, 1);
assert.equal('residents' in coreState, false);
assert.equal('deliveries' in coreState, false);
assert.equal('commands' in coreState, false);
assert.equal('auditTrail' in coreState, false);
assert.deepEqual(coreState.notificationOutbox, [{ id: 'mail-1' }]);
assert.equal(operationalData.deliveries[0].id, 'delivery-1');

const rows = buildOperationalRows(operationalData);
assert.equal(rows.residents[0].email, 'morador@example.com');
assert.equal(rows.deliveries[0].door, 3);
assert.equal(rows.deliveries[0].deposited_at, '');
assert.equal(rows.deliveries[0].data.id, 'delivery-1');
assert.equal(rows.commands[0].command_id, 'command-1');
assert.equal(rows.commands[0].lease_id, 'lease-command-1');
assert.equal(rows.commands[0].delivery_attempt, 2);
assert.equal(rows.commands[0].acknowledged_at, '2026-07-15T13:06:00.000Z');
assert.deepEqual(rows.auditTrail[0].meta, { deliveryId: 'delivery-1' });
assert.deepEqual(
  Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, value.length])),
  { residents: 1, deliveries: 1, commands: 1, auditTrail: 1 }
);

const genericQueries = [];
const genericClient = {
  async query(sql) {
    genericQueries.push(String(sql));
    return { rows: [] };
  },
};
await persistOperationalStateInTransaction(genericClient, {
  tenantId: 'tenant-test',
  lockerId: 'locker-test',
  schemaVersion: 9,
  state,
  synchronizeCommands: false,
});
assert.equal(genericQueries.some((sql) => /(?:insert into|delete from) preddita_commands/i.test(sql)), false);

const backfillQueries = [];
await persistOperationalStateInTransaction({
  async query(sql) {
    backfillQueries.push(String(sql));
    return { rows: [] };
  },
}, {
  tenantId: 'tenant-test',
  lockerId: 'locker-test',
  schemaVersion: 9,
  state,
  synchronizeCommands: true,
});
assert.equal(backfillQueries.some((sql) => /insert into preddita_commands/i.test(sql)), true);

console.log('PREDDITA_OPERATIONAL_STORE_OK');
