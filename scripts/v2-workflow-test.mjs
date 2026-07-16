import assert from 'node:assert/strict';

import {
  cancelDelivery,
  completePickup,
  confirmDeposit,
  createDoorCatalog,
  createInitialState,
  findAvailableDoor,
  getDoorOccupancyMap,
  markDepositDoorOpened,
  markPickupDoorOpened,
  releaseDoorOccupancy,
  reserveDelivery,
  resolvePickupRequest,
} from '../web/src/lockerWorkflow.js';
import { createPhysicalDoorProofs } from './door-safety-fixtures.mjs';
import {
  applyBackspaceKey,
  applyDigitKey,
  getCourierSuccessPresentation,
  getPickupEntryPresentation,
  isCompletePin,
  isDoorClosedForCompletion,
  shouldShowCourierPickupCredential,
} from '../web/src/touchFlow.js';
import {
  applyDeviceEventSyncResult,
  buildDeliveryCollectedEventId,
  buildDeliveryStoredEventId,
  upsertDeviceEventQueue,
} from '../web/src/deviceEventQueue.js';
import { getRemoteBridgeConfig } from '../web/src/remoteBridge.js';

const recipient = {
  id: 'resident-test',
  firstName: '',
  lastName: '',
  name: 'Apartamento 101',
  cpf: '',
  unit: 'Torre A - 101',
  building: 'Torre A',
  floor: '1',
  apartment: '101',
  phone: '47999990000',
  email: 'morador@example.com',
};

const baseState = {
  ...createInitialState(),
  recipients: [recipient],
  deviceConfig: { board: 1, doorCount: 10 },
  deliveries: [],
};

let physicalSequence = 0;
function storeReservation(reservation, evidence = {}) {
  const physical = createPhysicalDoorProofs(
    reservation.delivery.door,
    'dropoff',
    physicalSequence++
  );
  const openedState = markDepositDoorOpened(
    reservation.state,
    reservation.delivery.id,
    physical.cycle
  );
  return confirmDeposit(openedState, reservation.delivery.id, evidence, physical.closeProof);
}

const catalog = createDoorCatalog(10);
const smallDoorCatalog = catalog.filter((door) => door.size === 'P');
const largeDoorCatalog = catalog.filter((door) => door.size === 'G');
const productionLikeRemoteConfig = getRemoteBridgeConfig();
assert.deepEqual(productionLikeRemoteConfig.baseUrls, [], 'build sem ambiente nao deve usar endpoint HTTP embutido');
assert.equal(productionLikeRemoteConfig.deviceKey, '', 'build sem ambiente nao deve usar chave global embutida');
assert.equal(catalog[0].size, 'G', 'porta 1 deve ser grande');
assert.equal(catalog[1].size, 'G', 'porta 2 deve ser grande');
assert.equal(catalog[2].size, 'P', 'porta 3 deve ser pequena');
assert.equal(catalog[9].size, 'P', 'porta 10 deve ser pequena');
assert.equal(applyDigitKey('12345', '6'), '123456', 'teclado de retirada deve aceitar seis digitos');
assert.equal(applyDigitKey('123456', '7'), '123456', 'teclado de retirada nao deve passar de seis digitos');
assert.equal(applyDigitKey('123', 'x'), '123', 'teclado de retirada deve ignorar caracteres nao numericos');
assert.equal(applyBackspaceKey('123456'), '12345', 'teclado de retirada deve apagar um digito por toque');
assert.equal(isCompletePin('123456'), true, 'PIN de seis digitos deve ficar pronto para validacao');
assert.equal(isCompletePin('12345'), false, 'PIN incompleto nao deve abrir tentativa de retirada');
assert.equal(isDoorClosedForCompletion('closed'), true, 'confirmacao fisica so deve concluir com sensor fechado');
assert.equal(isDoorClosedForCompletion('open'), false, 'sensor aberto deve bloquear conclusao da entrega');
assert.equal(isDoorClosedForCompletion('unknown'), false, 'sensor sem leitura deve bloquear conclusao segura');
assert.equal(
  shouldShowCourierPickupCredential({ recipientEmail: 'morador@example.com' }),
  false,
  'sucesso do entregador nao deve expor PIN/QR quando houver e-mail cadastrado'
);
assert.equal(
  shouldShowCourierPickupCredential({ recipientEmail: '' }),
  true,
  'sucesso do entregador deve expor PIN/QR quando nao houver e-mail cadastrado'
);
assert.deepEqual(
  getCourierSuccessPresentation({ recipientEmail: 'morador@example.com', pin: '123456' }),
  {
    title: 'Pronto',
    shouldShowCredential: false,
    primaryText: 'A encomenda ficou registrada.',
    secondaryText: 'O morador recebera o codigo quando o armario sincronizar.',
    autoReturn: true,
  },
  'sucesso com e-mail deve esconder PIN/QR e voltar automaticamente'
);
assert.deepEqual(
  getCourierSuccessPresentation({ recipientEmail: '', pin: '123456' }),
  {
    title: 'Anote o PIN',
    shouldShowCredential: true,
    primaryText: 'A encomenda ficou registrada.',
    secondaryText: 'Este apartamento nao tem e-mail cadastrado.',
    autoReturn: false,
  },
  'sucesso sem e-mail deve manter PIN/QR visiveis'
);
assert.deepEqual(
  getPickupEntryPresentation('pin', '12345'),
  {
    title: 'Digite seu PIN',
    helper: 'Digite os 6 numeros recebidos.',
    canSubmit: false,
    shouldAutoSubmit: false,
  },
  'PIN incompleto nao deve tentar abrir'
);
assert.deepEqual(
  getPickupEntryPresentation('pin', '123456'),
  {
    title: 'Abrindo sua porta',
    helper: 'Conferindo o codigo recebido.',
    canSubmit: true,
    shouldAutoSubmit: true,
  },
  'PIN completo deve validar automaticamente'
);

assert.equal(
  buildDeliveryStoredEventId('delivery-abc'),
  'edge-delivery-stored-delivery-abc',
  'evento de deposito deve ter id deterministico por entrega'
);
assert.equal(
  buildDeliveryCollectedEventId('delivery-abc'),
  'edge-delivery-collected-delivery-abc',
  'evento de retirada deve ter id deterministico por entrega'
);
const queuedOnce = upsertDeviceEventQueue([], {
  id: buildDeliveryStoredEventId('delivery-abc'),
  type: 'delivery-stored',
  payload: { attempt: 1 },
}, 5);
const queuedTwice = upsertDeviceEventQueue(queuedOnce, {
  id: buildDeliveryStoredEventId('delivery-abc'),
  type: 'delivery-stored',
  payload: { attempt: 2 },
}, 5);
assert.equal(queuedTwice.length, 1, 'fila offline deve substituir evento repetido da mesma entrega');
assert.equal(queuedTwice[0].payload.attempt, 2, 'fila offline deve manter a versao mais recente do evento');
const cappedQueue = ['1', '2', '3', '4', '5', '6'].reduce(
  (queue, id) => upsertDeviceEventQueue(queue, { id, type: 'test', payload: {} }, 3),
  []
);
assert.deepEqual(cappedQueue.map((event) => event.id), ['4', '5', '6'], 'fila offline deve manter somente os eventos mais recentes');
const syncQueue = [
  { id: 'accepted', type: 'test', attempts: 0 },
  { id: 'failed', type: 'test', attempts: 80 },
  { id: 'waiting', type: 'test', attempts: 0 },
];
const syncResult = applyDeviceEventSyncResult(syncQueue, {
  acceptedIds: ['accepted'],
  failedEvents: [{ id: 'failed', error: 'falha permanente simulada' }],
}, '2026-07-15T12:00:00.000Z', 5);
assert.deepEqual(
  syncResult.pending.map((event) => event.id),
  ['waiting', 'failed'],
  'evento rejeitado deve ir ao fim para nao bloquear os eventos seguintes'
);
assert.equal(syncResult.failed[0].attempts, 81, 'evento nao deve ser descartado ao atingir 80 tentativas');
assert.equal(
  syncResult.failed[0].lastAttemptAt,
  '2026-07-15T12:00:00.000Z',
  'nova tentativa deve ficar auditavel no diario local'
);

await assert.rejects(
  () => reserveDelivery(baseState, {
    recipientId: recipient.id,
    packageSize: '',
    courierName: 'Teste',
    orderCode: 'NO-SIZE',
    doorCatalog: catalog,
  }),
  /tamanho do volume/,
  'deposito sem volume selecionado deve ser bloqueado pela regra de negocio'
);

const smallReservation = await reserveDelivery(baseState, {
  recipientId: recipient.id,
  packageSize: 'P',
  courierName: 'Teste',
  orderCode: 'SMALL-1',
  doorCatalog: catalog,
});
assert.equal(smallReservation.delivery.door, 3, 'volume pequeno deve preferir a primeira porta pequena livre');
assert.equal(smallReservation.delivery.recipientName, 'Apartamento 101', 'entrega deve expor somente o apartamento');
assert.equal(smallReservation.delivery.recipientCpf, '', 'entrega nao deve expor CPF');

const labelEvidence = {
  labelPhotoDataUrl: 'data:image/jpeg;base64,Zm90by1kYS1ldGlxdWV0YQ==',
  labelPhotoCapturedAt: '2026-07-08T10:00:00.000Z',
  labelOcrStatus: 'photo-captured',
  labelOcrApartment: '101',
  labelOcrConfidence: 1,
  labelProofRequired: true,
};
await assert.rejects(
  async () => confirmDeposit(smallReservation.state, smallReservation.delivery.id, labelEvidence),
  /abertura fisica/,
  'deposito sem prova de abertura deve ser bloqueado'
);
const storedSmallState = storeReservation(smallReservation, labelEvidence);
const storedSmallDelivery = storedSmallState.deliveries.find((delivery) => delivery.id === smallReservation.delivery.id);
assert.equal(storedSmallDelivery.labelPhotoDataUrl, labelEvidence.labelPhotoDataUrl, 'confirmacao deve persistir foto da etiqueta');
assert.equal(storedSmallDelivery.labelOcrApartment, '101', 'confirmacao deve persistir apartamento validado pela etiqueta');
assert.equal(storedSmallDelivery.labelProofRequired, true, 'confirmacao deve indicar que o comprovante de etiqueta foi solicitado');
const pickupByPin = resolvePickupRequest(storedSmallState, 'pin', smallReservation.delivery.pin);
assert.equal(pickupByPin.ok, true, 'PIN gerado deve localizar entrega ativa');
assert.equal(pickupByPin.delivery.id, smallReservation.delivery.id);

const pickupByQr = resolvePickupRequest(storedSmallState, 'predditaQr', smallReservation.delivery.qrPayload);
assert.equal(pickupByQr.ok, true, 'QR PREDDITA gerado deve localizar entrega ativa');
assert.equal(pickupByQr.delivery.id, smallReservation.delivery.id);

const pickupPhysical = createPhysicalDoorProofs(smallReservation.delivery.door, 'pickup', physicalSequence++);
const pickupOpenedState = markPickupDoorOpened(
  storedSmallState,
  smallReservation.delivery.id,
  pickupPhysical.cycle
);
const pickupOpenedDelivery = pickupOpenedState.deliveries.find((delivery) => delivery.id === smallReservation.delivery.id);
assert.equal(pickupOpenedDelivery.status, 'pickup_opened', 'retirada deve ficar pendente apos abrir a porta');
assert.equal(
  getDoorOccupancyMap(pickupOpenedState.deliveries)[smallReservation.delivery.door]?.id,
  smallReservation.delivery.id,
  'porta deve continuar ocupada ate finalizar a retirada'
);

assert.throws(
  () => completePickup(pickupOpenedState, smallReservation.delivery.id),
  /fechamento fisico/,
  'retirada sem prova de fechamento deve permanecer ocupada'
);
const pickupCompletedState = completePickup(
  pickupOpenedState,
  smallReservation.delivery.id,
  pickupPhysical.closeProof
);
const pickupCompletedDelivery = pickupCompletedState.deliveries.find((delivery) => delivery.id === smallReservation.delivery.id);
assert.equal(pickupCompletedDelivery.status, 'collected', 'retirada so libera apos confirmacao final');
assert.equal(pickupCompletedDelivery.pin, '', 'retirada concluida deve apagar o PIN imediatamente');
assert.equal(pickupCompletedDelivery.token, '', 'retirada concluida deve apagar o token imediatamente');
assert.equal(pickupCompletedDelivery.qrPayload, '', 'retirada concluida deve apagar o QR imediatamente');
assert.ok(pickupCompletedDelivery.credentialsErasedAt, 'retirada concluida deve registrar quando as credenciais foram apagadas');
assert.equal(
  getDoorOccupancyMap(pickupCompletedState.deliveries)[smallReservation.delivery.door],
  undefined,
  'porta deve ficar livre depois de finalizar retirada'
);

const invalidQr = resolvePickupRequest(storedSmallState, 'predditaQr', 'qr-invalido');
assert.equal(invalidQr.ok, false, 'QR fora do formato PREDDITA deve falhar sem excecao');

const remotePhysical = createPhysicalDoorProofs(
  smallReservation.delivery.door,
  'remote-admin',
  physicalSequence++
);
const remotelyOpenedState = markPickupDoorOpened(
  storedSmallState,
  smallReservation.delivery.id,
  remotePhysical.cycle,
  { source: 'remote-admin' }
);
assert.throws(
  () => releaseDoorOccupancy(remotelyOpenedState, smallReservation.delivery.door, 'remote-admin'),
  /fechamento fisico/,
  'abertura remota nao deve liberar ocupacao antes do fechamento'
);
const releasedState = releaseDoorOccupancy(
  remotelyOpenedState,
  smallReservation.delivery.door,
  'remote-admin',
  remotePhysical.closeProof
);
const releasedDelivery = releasedState.deliveries.find((delivery) => delivery.id === smallReservation.delivery.id);
assert.equal(releasedDelivery.status, 'collected', 'abertura admin de porta ocupada deve liberar entrega');
assert.equal(getDoorOccupancyMap(releasedState.deliveries)[smallReservation.delivery.door], undefined, 'porta liberada deve sair do mapa de ocupacao');

const largeReservation = await reserveDelivery(baseState, {
  recipientId: recipient.id,
  packageSize: 'G',
  courierName: 'Teste',
  orderCode: 'LARGE-1',
  doorCatalog: catalog,
});
assert.equal(largeReservation.delivery.door, 1, 'volume grande deve escolher a primeira porta grande livre');

const courierSmallReservation = await reserveDelivery(baseState, {
  recipientId: recipient.id,
  packageSize: 'P',
  courierName: 'Entregador',
  orderCode: 'COURIER-SMALL-FIRST',
  doorCatalog: smallDoorCatalog,
});
assert.equal(
  courierSmallReservation.delivery.door,
  3,
  'fluxo publico do entregador deve abrir sempre a primeira porta pequena livre'
);

const cancelledSmallState = cancelDelivery(
  courierSmallReservation.state,
  courierSmallReservation.delivery.id,
  'Entrega nao coube na porta pequena.'
);
const cancelledSmallDelivery = cancelledSmallState.deliveries.find(
  (delivery) => delivery.id === courierSmallReservation.delivery.id
);
assert.equal(cancelledSmallDelivery.pin, '', 'reserva cancelada deve apagar o PIN imediatamente');
assert.equal(cancelledSmallDelivery.token, '', 'reserva cancelada deve apagar o token imediatamente');
assert.equal(cancelledSmallDelivery.qrPayload, '', 'reserva cancelada deve apagar o QR imediatamente');
assert.ok(cancelledSmallDelivery.credentialsErasedAt, 'reserva cancelada deve registrar a limpeza das credenciais');
assert.equal(
  getDoorOccupancyMap(cancelledSmallState.deliveries)[courierSmallReservation.delivery.door],
  undefined,
  'ao pedir porta grande, a reserva pequena cancelada deve liberar a porta pequena'
);

const courierLargeFallback = await reserveDelivery(cancelledSmallState, {
  recipientId: recipient.id,
  packageSize: 'G',
  courierName: 'Entregador',
  orderCode: 'COURIER-LARGE-FALLBACK',
  doorCatalog: largeDoorCatalog,
});
assert.equal(courierLargeFallback.delivery.door, 1, 'fallback do fluxo publico deve abrir a primeira porta grande livre');

let noLargeDoorsState = baseState;
for (const largeDoor of largeDoorCatalog) {
  const reservation = await reserveDelivery(noLargeDoorsState, {
    recipientId: recipient.id,
    packageSize: 'G',
    courierName: 'Teste',
    orderCode: `FILL-LARGE-${largeDoor.channel}`,
    doorCatalog: [largeDoor],
  });
  noLargeDoorsState = storeReservation(reservation);
}
assert.equal(
  findAvailableDoor(noLargeDoorsState, 'G', largeDoorCatalog),
  null,
  'fluxo publico deve detectar quando todas as portas grandes estao ocupadas'
);
assert.equal(
  findAvailableDoor(noLargeDoorsState, 'P', smallDoorCatalog)?.channel,
  3,
  'portas pequenas ainda podem estar livres mesmo sem porta grande disponivel'
);

let noSmallDoorsState = baseState;
for (const smallDoor of smallDoorCatalog) {
  const reservation = await reserveDelivery(noSmallDoorsState, {
    recipientId: recipient.id,
    packageSize: 'P',
    courierName: 'Teste',
    orderCode: `FILL-SMALL-${smallDoor.channel}`,
    doorCatalog: [smallDoor],
  });
  noSmallDoorsState = storeReservation(reservation);
}
await assert.rejects(
  () => reserveDelivery(noSmallDoorsState, {
    recipientId: recipient.id,
    packageSize: 'P',
    courierName: 'Entregador',
    orderCode: 'NO-SMALL-LEFT',
    doorCatalog: smallDoorCatalog,
  }),
  /Nao ha compartimentos/,
  'fluxo publico deve avisar falta de porta pequena antes de usar porta grande'
);

const badPin = resolvePickupRequest(storedSmallState, 'pin', '000000');
assert.equal(badPin.ok, false, 'PIN inexistente deve falhar');

console.log('PREDDITA_V2_WORKFLOW_OK');
