import assert from 'node:assert/strict';

import {
  buildCommissioningRecord,
  inferSensorPolarityFromClosedStateByte,
  isCommissioningCurrent,
  normalizeCommissioningRecord,
  normalizeDoorSizes,
  normalizeUnlockTimeoutSeconds,
} from '../web/src/commissioning.js';
import {
  applyDeviceCommissioning,
  createDoorCatalog,
  createInitialState,
  updateDeviceConfig,
} from '../web/src/lockerWorkflow.js';
import { createPhysicalDoorProofs } from './door-safety-fixtures.mjs';

assert.equal(inferSensorPolarityFromClosedStateByte(0x11), 'zeroOpen');
assert.equal(inferSensorPolarityFromClosedStateByte(0x00), 'zeroClosed');
assert.equal(inferSensorPolarityFromClosedStateByte(0x33), '');
assert.equal(normalizeUnlockTimeoutSeconds(0), 1);
assert.equal(normalizeUnlockTimeoutSeconds(99), 30);
assert.deepEqual(
  normalizeDoorSizes(['P', 'M', 'G'], 3),
  ['P', 'M', 'G'],
  'mapa fisico deve preservar tamanhos configurados',
);

const channels = ['P', 'M', 'G'].map((size, index) => {
  const physical = createPhysicalDoorProofs(index + 1, 'commissioning', index);
  return {
    channel: index + 1,
    size,
    status: 'passed',
    cycle: physical.cycle,
    closeProof: physical.closeProof,
  };
});
const completedAt = new Date(Date.UTC(2026, 6, 15, 13, 0, 0)).toISOString();
const record = buildCommissioningRecord({
  board: 2,
  doorCount: 3,
  sensorPolarity: 'zeroOpen',
  unlockTimeoutSeconds: 5,
  doorSizes: ['P', 'M', 'G'],
  channels,
  startedAt: new Date(Date.UTC(2026, 6, 15, 11, 0, 0)).toISOString(),
  completedAt,
});

assert.equal(record.status, 'complete');
assert.equal(record.channels.length, 3);
assert.equal(record.completedAt, completedAt);
assert.equal(
  isCommissioningCurrent(record, {
    board: 2,
    doorCount: 3,
    sensorPolarity: 'zeroOpen',
    unlockTimeoutSeconds: 5,
    doorSizes: ['P', 'M', 'G'],
  }),
  true,
  'registro completo deve corresponder a configuracao aplicada',
);

assert.throws(
  () => buildCommissioningRecord({
    board: 2,
    doorCount: 3,
    sensorPolarity: 'zeroOpen',
    unlockTimeoutSeconds: 5,
    doorSizes: ['P', 'M', 'G'],
    channels: channels.slice(0, 2),
  }),
  /Todos os canais/,
  'nao pode concluir com canal pendente',
);

const commissionedState = applyDeviceCommissioning(createInitialState(), {
  ...record,
  doorSizes: ['P', 'M', 'G'],
});
assert.equal(commissionedState.deviceConfig.commissioning.status, 'complete');
assert.deepEqual(
  createDoorCatalog(3, commissionedState.deviceConfig.doorSizes).map((door) => door.size),
  ['P', 'M', 'G'],
  'catalogo operacional deve usar o mapa comissionado',
);

const unchanged = updateDeviceConfig(commissionedState, {
  board: 2,
  doorCount: 3,
  sensorPolarity: 'zeroOpen',
});
assert.equal(
  unchanged.deviceConfig.commissioning.status,
  'complete',
  'reaplicar a mesma configuracao deve preservar a certificacao',
);

const changed = updateDeviceConfig(commissionedState, { board: 3 });
assert.equal(
  changed.deviceConfig.commissioning.status,
  'pending',
  'alterar board deve invalidar o comissionamento anterior',
);
assert.equal(
  changed.deviceConfig.commissioning.channels.every((channel) => channel.status === 'pending'),
  true,
  'invalidacao deve remover provas antigas de todos os canais',
);

assert.equal(
  normalizeCommissioningRecord(record, {
    board: 3,
    doorCount: 3,
    sensorPolarity: 'zeroOpen',
    unlockTimeoutSeconds: 5,
    doorSizes: ['P', 'M', 'G'],
  }).status,
  'pending',
  'registro salvo para outro board nao pode ser reativado ao recarregar',
);

assert.equal(
  normalizeCommissioningRecord(record, {
    board: 2,
    doorCount: 3,
    sensorPolarity: 'zeroOpen',
    unlockTimeoutSeconds: 5,
    doorSizes: ['P', 'G', 'G'],
  }).status,
  'pending',
  'mudanca no mapa fisico deve invalidar o registro salvo',
);

console.log('PREDDITA_V2_COMMISSIONING_OK');
