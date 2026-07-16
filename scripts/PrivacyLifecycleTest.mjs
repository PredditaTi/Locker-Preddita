import assert from 'node:assert/strict';
import {
  applyPrivacyLifecycle,
  buildPrivacySummary,
  buildResidentDataExport,
  eraseResidentData,
  normalizePrivacyConfig,
  sanitizeAuditMessage,
  sanitizeAuditMeta,
} from '../admin-online/privacyLifecycle.mjs';

const NOW = Date.UTC(2026, 6, 16, 12, 0, 0);
const ago = (days) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();
const config = normalizePrivacyConfig({
  PREDDITA_PRIVACY_CONTROLLER_NAME: 'Condominio Teste',
  PREDDITA_PRIVACY_CONTACT_EMAIL: 'LGPD@EXAMPLE.COM',
});

assert.equal(config.contactEmail, 'lgpd@example.com');
assert.equal(config.deliveryEvidenceRetentionDays, 30);
assert.equal(config.deliveryPersonalDataRetentionDays, 90);
assert.equal(config.deliveryRecordRetentionDays, 730);

const delivery = (id, status, days, extra = {}) => ({
  id,
  recipientId: `resident-${id}`,
  recipientName: 'Apartamento 901',
  recipientEmail: 'morador@example.com',
  recipientCpf: '123.456.789-00',
  unit: 'Torre A - Ap 901',
  building: 'Torre A',
  courierName: 'Entregador Teste',
  orderCode: 'ORDER-123',
  notes: 'Deixar na porta',
  door: 3,
  size: 'P',
  status,
  pin: '731904',
  token: `TOKEN-${id}`,
  qrPayload: `preddita://collect?id=${id}&token=TOKEN-${id}`,
  externalCode: `EXTERNAL-${id}`,
  labelPhotoDataUrl: 'data:image/jpeg;base64,Zm90bw==',
  labelPhotoCapturedAt: ago(days),
  labelOcrStatus: 'photo-captured',
  labelOcrText: 'Apartamento 901',
  labelOcrApartment: '901',
  labelOcrConfidence: 1,
  labelProofRequired: true,
  createdAt: ago(days + 1),
  depositedAt: ago(days),
  ...(status === 'collected' ? { collectedAt: ago(days) } : {}),
  ...(status === 'cancelled' ? { cancelledAt: ago(days) } : {}),
  ...extra,
});

const initial = {
  residents: [
    { id: 'resident-active', apartment: '101', phone: '11999990000', email: 'active@example.com' },
  ],
  deliveries: [
    delivery('active', 'stored', 200, { recipientId: 'resident-active' }),
    delivery('recent', 'collected', 1),
    delivery('evidence-old', 'collected', 45),
    delivery('personal-old', 'collected', 120),
    delivery('record-old', 'cancelled', 800),
  ],
  doors: [
    { channel: 3, occupancy: 'busy', delivery: { id: 'active', unit: 'Torre A - Ap 101' } },
    { channel: 4, occupancy: 'busy', delivery: { id: 'record-old', unit: 'Torre A - Ap 901' } },
  ],
  auditTrail: [
    {
      id: 'audit-recent',
      kind: 'delivery-email-sent',
      message: 'PIN 731904 enviado para morador@example.com.',
      meta: { recipientEmail: 'morador@example.com', deliveryId: 'recent' },
      at: ago(1),
    },
    { id: 'audit-old', kind: 'old', message: 'Antigo', meta: {}, at: ago(400) },
  ],
  commands: [
    { id: 'command-recent', status: 'completed', completedAt: ago(1) },
    { id: 'command-old', status: 'failed', completedAt: ago(400) },
  ],
  notificationOutbox: [
    { id: 'mail-recent', deliveryId: 'recent', status: 'sent', sentAt: ago(1) },
    { id: 'mail-old', deliveryId: 'personal-old', status: 'sent', sentAt: ago(40) },
    { id: 'mail-pending', deliveryId: 'active', status: 'pending', requestedAt: ago(40) },
  ],
  processedDeviceEvents: [
    { id: 'event-recent', processedAt: ago(1) },
    { id: 'event-old', processedAt: ago(400) },
  ],
};

const applied = applyPrivacyLifecycle(initial, { config, nowMs: NOW });
assert.equal(applied.changed, true);
assert.equal(applied.result.credentialsErased, 3);
assert.equal(applied.result.evidenceErased, 2);
assert.equal(applied.result.deliveriesAnonymized, 1);
assert.equal(applied.result.deliveriesRemoved, 1);
assert.equal(applied.result.auditEntriesSanitized, 1);
assert.equal(applied.result.auditEntriesRemoved, 1);
assert.equal(applied.result.commandsRemoved, 1);
assert.equal(applied.result.notificationsRemoved, 2);
assert.equal(applied.result.processedEventsRemoved, 1);
assert.equal(applied.result.doorReferencesRemoved, 1);

const active = applied.state.deliveries.find((item) => item.id === 'active');
assert.equal(active.pin, '731904', 'active delivery credential must remain usable');
assert.equal(active.labelPhotoDataUrl.startsWith('data:image/'), true);

const recent = applied.state.deliveries.find((item) => item.id === 'recent');
assert.equal(recent.pin, '');
assert.equal(recent.token, '');
assert.equal(recent.qrPayload, '');
assert.equal(recent.recipientEmail, 'morador@example.com');
assert.ok(recent.credentialsErasedAt);

const evidenceOld = applied.state.deliveries.find((item) => item.id === 'evidence-old');
assert.equal(evidenceOld.labelPhotoDataUrl, '');
assert.equal(evidenceOld.labelOcrText, '');
assert.equal(evidenceOld.recipientEmail, 'morador@example.com');
assert.ok(evidenceOld.evidenceErasedAt);

const personalOld = applied.state.deliveries.find((item) => item.id === 'personal-old');
assert.equal(personalOld.recipientId, '');
assert.equal(personalOld.recipientEmail, '');
assert.equal(personalOld.unit, '');
assert.ok(personalOld.personalDataAnonymizedAt);
assert.equal(applied.state.deliveries.some((item) => item.id === 'record-old'), false);
assert.equal(applied.state.doors[1].delivery, null);
assert.equal(applied.state.notificationOutbox.some((item) => item.id === 'mail-pending'), true);
assert.equal(applied.state.notificationOutbox.some((item) => item.id === 'mail-recent'), false);

assert.equal(applied.state.auditTrail[0].message.includes('731904'), false);
assert.equal(applied.state.auditTrail[0].message.includes('morador@example.com'), false);
assert.equal(applied.state.auditTrail[0].meta.recipientEmail, '[dado protegido]');
assert.equal(applied.state.commands.some((item) => item.id === 'command-old'), false);
assert.equal(applied.state.processedDeviceEvents.some((item) => item.id === 'event-old'), false);

const summary = buildPrivacySummary(applied.state, { config, nowMs: NOW });
assert.equal(summary.policy.controllerName, 'Condominio Teste');
assert.equal(summary.metrics.terminalCredentialsPending, 0);
assert.equal(summary.metrics.personalDataPastRetention, 0);
assert.equal(summary.metrics.evidencePastRetention, 0);
assert.ok(summary.lastAppliedAt);

const secondPass = applyPrivacyLifecycle(applied.state, { config, nowMs: NOW });
assert.equal(secondPass.changed, false, 'privacy lifecycle must be idempotent');

const blockedErasure = eraseResidentData(initial, 'resident-active', { nowMs: NOW });
assert.equal(blockedErasure.ok, false);
assert.equal(blockedErasure.status, 409);
assert.deepEqual(blockedErasure.activeDeliveryIds, ['active']);

const residentState = {
  residents: [
    { id: 'resident-erase', apartment: '901', building: 'Torre A', phone: '11999990000', email: 'erase@example.com', cpf: '' },
  ],
  deliveries: [
    delivery('erase-terminal', 'collected', 1, { recipientId: 'resident-erase' }),
    delivery('erase-legacy', 'legacy-terminal', 1, {
      recipientId: 'resident-erase',
      recipientPhone: '11999990000',
      cancelReason: 'Solicitado por erase@example.com',
    }),
  ],
  doors: [{ channel: 9, occupancy: 'busy', delivery: { id: 'erase-terminal', unit: 'Torre A - Ap 901' } }],
  notificationOutbox: [
    { id: 'mail-erase', deliveryId: 'erase-terminal', status: 'sent', sentAt: ago(1) },
  ],
  auditTrail: [
    { id: 'audit-erase', kind: 'resident', message: 'erase@example.com', meta: { residentId: 'resident-erase' }, at: ago(1) },
  ],
};
const exportPayload = buildResidentDataExport(residentState, 'resident-erase', { nowMs: NOW });
assert.equal(exportPayload.resident.email, 'erase@example.com');
assert.equal(exportPayload.deliveries[0].credentials.retained, true);
const serializedExport = JSON.stringify(exportPayload);
assert.equal(serializedExport.includes('731904'), false);
assert.equal(serializedExport.includes('TOKEN-erase-terminal'), false);
assert.equal(serializedExport.includes('preddita://'), false);

const erased = eraseResidentData(residentState, 'resident-erase', { nowMs: NOW });
assert.equal(erased.ok, true);
assert.equal(erased.anonymizedDeliveryCount, 2);
assert.equal(erased.state.residents.length, 0);
assert.equal(erased.state.deliveries[0].recipientEmail, '');
assert.equal(erased.state.deliveries[0].pin, '');
assert.equal(erased.state.deliveries[1].pin, '');
assert.equal(erased.state.deliveries[1].recipientPhone, '');
assert.equal(erased.state.deliveries[1].cancelReason, '');
assert.equal(erased.state.notificationOutbox.length, 0);
assert.equal(erased.state.auditTrail[0].meta.residentId, 'eliminado');
assert.equal(erased.state.auditTrail[0].message, 'Registro relacionado a cadastro eliminado.');
assert.equal(erased.state.doors[0].delivery, null);

assert.equal(sanitizeAuditMessage('PIN 123456 para pessoa@example.com').includes('123456'), false);
assert.deepEqual(
  sanitizeAuditMeta({ email: 'person@example.com', nested: { token: 'abc', door: 3 } }),
  { email: '[dado protegido]', nested: { token: '[dado protegido]', door: 3 } }
);

console.log('PASS privacy retention, credential erasure, anonymization and resident rights');
