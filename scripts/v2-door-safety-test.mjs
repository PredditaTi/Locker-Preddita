import assert from 'node:assert/strict';

import {
  createDoorCloseProof,
  createDoorOpenCycle,
  isValidDoorCloseProof,
  validateDirectDoorReading,
} from '../web/src/doorSafety.js';

const now = Date.now();
const at = (offsetMs) => new Date(now + offsetMs).toISOString();
const reading = (overrides = {}) => ({
  channel: 3,
  status: 'closed',
  source: 'single',
  stateByte: 0x11,
  statusKnown: true,
  validChecksum: true,
  ambiguous: false,
  sensorPolarity: 'zeroOpen',
  readAt: at(-3_000),
  ...overrides,
});

assert.equal(
  validateDirectDoorReading(reading(), 'closed', { channel: 3 }).ok,
  true,
  'leitura individual fechada e recente deve ser aceita'
);
assert.equal(
  validateDirectDoorReading(reading({ source: 'packed' }), 'closed').reason,
  'not-direct',
  'leitura em bloco nao pode comprovar fechamento'
);
assert.equal(
  validateDirectDoorReading(reading({ validChecksum: false }), 'closed').reason,
  'invalid-checksum',
  'checksum invalido deve bloquear a operacao'
);
assert.equal(
  validateDirectDoorReading(reading({ readAt: at(-60_000) }), 'closed').reason,
  'stale-reading',
  'leitura antiga nao pode ser reutilizada'
);

const baseline = reading();
const opened = reading({ status: 'open', stateByte: 0x00, readAt: at(-2_000) });
const openResult = createDoorOpenCycle(baseline, opened, 'dropoff');
assert.equal(openResult.ok, true, 'transicao fechada-aberta deve criar prova de abertura');

assert.equal(
  createDoorOpenCycle(baseline, reading({ status: 'open', readAt: at(-2_000) }), 'dropoff').reason,
  'sensor-did-not-transition',
  'sensor sem mudanca de byte nao pode confirmar abertura'
);

const closed = reading({ readAt: at(-1_000) });
const closeResult = createDoorCloseProof(openResult.cycle, closed);
assert.equal(closeResult.ok, true, 'nova leitura fechada deve concluir o ciclo');
assert.equal(
  isValidDoorCloseProof(openResult.cycle, closeResult.proof),
  true,
  'prova de fechamento deve validar contra a abertura correspondente'
);
assert.equal(
  createDoorCloseProof(openResult.cycle, reading({ readAt: at(-2_500) })).reason,
  'reading-before-transition',
  'fechamento anterior a abertura deve ser rejeitado'
);
assert.equal(
  createDoorCloseProof(openResult.cycle, reading({ channel: 4, readAt: at(-1_000) })).reason,
  'wrong-channel',
  'fechamento de outro canal deve ser rejeitado'
);

console.log('PREDDITA_V2_DOOR_SAFETY_OK');
