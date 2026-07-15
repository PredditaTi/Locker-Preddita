import assert from 'node:assert/strict';

import { resolveScannedPickupCredential } from '../web/src/qrScanner.js';

const predditaPayload = 'preddita://collect?id=delivery-1&token=abc123&exp=2026-05-12T00%3A00%3A00.000Z';

assert.deepEqual(
  resolveScannedPickupCredential(predditaPayload),
  { ok: true, mode: 'predditaQr', value: predditaPayload },
  'QR PREDDITA deve selecionar o modo de retirada por QR interno'
);

assert.deepEqual(
  resolveScannedPickupCredential(' 123 456 '),
  { ok: true, mode: 'pin', value: '123456' },
  'codigo numerico de 6 digitos deve ser tratado como PIN'
);

assert.deepEqual(
  resolveScannedPickupCredential('https://transportadora.example/pedido/123'),
  {
    ok: false,
    error: 'Este QR nao e um codigo PREDDITA. Digite o PIN recebido.',
  },
  'QR de terceiros nao deve abrir retirada publica sem vinculo explicito'
);

assert.deepEqual(
  resolveScannedPickupCredential(''),
  { ok: false, error: 'Aponte a camera para um QR de retirada ou digite o PIN.' },
  'leitura vazia deve gerar mensagem amigavel'
);

console.log('PREDDITA_V2_QR_SCANNER_OK');
