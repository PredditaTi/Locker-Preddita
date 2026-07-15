import assert from 'node:assert/strict';
import {
  frame,
  formatHex,
  parseResponse,
  responseMatchesRequest,
} from '../web/src/serial.js';

const unlockRequest = frame(0x8a, 0x01, 0x04, 0x33);
const unlockResponse = frame(0x8a, 0x01, 0x04, 0x00);
const parsedUnlock = parseResponse(formatHex(unlockResponse));
assert.equal(responseMatchesRequest(parsedUnlock, unlockRequest), true, 'resposta correta deve confirmar o comando');

const wrongBoard = parseResponse(formatHex(frame(0x8a, 0x02, 0x04, 0x00)));
assert.equal(responseMatchesRequest(wrongBoard, unlockRequest), false, 'placa diferente nao pode confirmar o comando');

const wrongChannel = parseResponse(formatHex(frame(0x8a, 0x01, 0x05, 0x00)));
assert.equal(responseMatchesRequest(wrongChannel, unlockRequest), false, 'canal diferente nao pode confirmar o comando');

const invalidBcc = [...unlockResponse];
invalidBcc[invalidBcc.length - 1] ^= 0x01;
assert.equal(
  responseMatchesRequest(parseResponse(formatHex(invalidBcc)), unlockRequest),
  false,
  'BCC invalido nao pode confirmar o comando'
);

const echo = parseResponse(formatHex(unlockRequest));
assert.equal(responseMatchesRequest(echo, unlockRequest), false, 'eco da placa nao pode confirmar a execucao');

const readAllRequest = frame(0x80, 0x01, 0x00, 0x33);
const readAllPayload = [0x80, 0x01, 0xff, 0xff, 0xff, 0x33];
const readAllResponse = [...readAllPayload, readAllPayload.reduce((checksum, value) => checksum ^ value, 0)];
const parsedReadAll = parseResponse(formatHex(readAllResponse));
assert.equal(parsedReadAll.type, 'all');
assert.equal(responseMatchesRequest(parsedReadAll, readAllRequest), true, 'leitura geral deve correlacionar por comando e placa');

const openAllRequest = frame(0x9d, 0x01, 0x01, 0x33);
const openAllPayload = [0x9e, 0x01, 0x00, 0x00, 0x00];
const openAllResponse = [...openAllPayload, openAllPayload.reduce((checksum, value) => checksum ^ value, 0)];
assert.equal(
  responseMatchesRequest(parseResponse(formatHex(openAllResponse)), openAllRequest),
  true,
  'resposta 0x9E deve correlacionar com comando 0x9D'
);

console.log('PREDDITA_V2_SERIAL_PROTOCOL_OK');
