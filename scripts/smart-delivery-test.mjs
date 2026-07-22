import assert from 'node:assert/strict';

import {
  DELIVERY_MODES,
  MIN_PACKAGE_ANALYSIS_CONFIDENCE,
  PACKAGE_ANALYSIS_STATUSES,
  canOpenDoorFromPackageAnalysis,
  createSmartDoorRecommendation,
  createEmptyPackageAnalysis,
  normalizeDeliveryMode,
  normalizePackageAnalysis,
} from '../web/src/smartDelivery.js';

assert.equal(normalizeDeliveryMode('manual'), DELIVERY_MODES.MANUAL);
assert.equal(normalizeDeliveryMode(' SMART '), DELIVERY_MODES.SMART);
assert.equal(normalizeDeliveryMode('automatic'), '', 'modo desconhecido deve ser recusado');

assert.deepEqual(createEmptyPackageAnalysis(), {
  status: PACKAGE_ANALYSIS_STATUSES.IDLE,
  suggestedSize: '',
  confidence: null,
  captureQuality: null,
  capturedAt: '',
  modelVersion: '',
  modelSha256: '',
  inferenceMs: 0,
  reasonCode: '',
});

const readySmall = normalizePackageAnalysis({
  status: 'ready',
  suggestedSize: 'p',
  confidence: 0.94,
  captureQuality: 1.4,
  capturedAt: '2026-07-22T12:00:00.000Z',
  modelVersion: 'package-pg-v1',
  modelSha256: 'a'.repeat(64),
  inferenceMs: 1870,
});
assert.equal(readySmall.suggestedSize, 'P');
assert.equal(readySmall.captureQuality, 1, 'qualidade deve ficar limitada ao intervalo 0..1');
assert.equal(canOpenDoorFromPackageAnalysis(readySmall), true);
assert.deepEqual(createSmartDoorRecommendation(readySmall, {
  nowMs: Date.parse('2026-07-22T12:01:00.000Z'),
}), {
  packageSize: 'P',
  confidence: 0.94,
  modelVersion: 'package-pg-v1',
  modelSha256: 'a'.repeat(64),
  inferenceMs: 1870,
  capturedAt: '2026-07-22T12:00:00.000Z',
});
assert.equal(createSmartDoorRecommendation(readySmall, {
  nowMs: Date.parse('2026-07-22T12:03:00.001Z'),
}), null, 'recomendacao com mais de dois minutos deve expirar');
assert.equal(
  normalizePackageAnalysis({ confidence: null }).confidence,
  null,
  'confianca nula deve permanecer nao calculada'
);

assert.equal(canOpenDoorFromPackageAnalysis({
  status: 'uncertain',
  suggestedSize: 'P',
  confidence: 0.51,
}), false, 'resultado incerto nunca deve autorizar abertura');
assert.equal(canOpenDoorFromPackageAnalysis({
  status: 'ready',
  suggestedSize: 'P',
  confidence: MIN_PACKAGE_ANALYSIS_CONFIDENCE - 0.01,
}), false, 'confianca abaixo do limite nunca deve autorizar abertura');
assert.equal(canOpenDoorFromPackageAnalysis({
  status: 'ready',
  suggestedSize: 'M',
  confidence: 0.99,
}), false, 'o primeiro contrato inteligente aceita somente P ou G');
assert.equal(canOpenDoorFromPackageAnalysis({
  status: 'ready',
  suggestedSize: 'G',
}), false, 'analise sem confianca nunca deve autorizar abertura');
assert.equal(canOpenDoorFromPackageAnalysis({
  status: 'ready',
  suggestedSize: 'G',
  confidence: 0.99,
  modelVersion: 'package-pg-v1',
  modelSha256: '',
}), false, 'resultado sem checksum do modelo nunca deve autorizar abertura');

console.log('Smart delivery tests passed.');
