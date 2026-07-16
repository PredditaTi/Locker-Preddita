import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { CommandWakeupRuntime } from '../web/src/commandWakeup.js';

class FakeMqttClient extends EventEmitter {
  constructor() {
    super();
    this.subscriptions = [];
    this.ended = false;
  }

  subscribe(topic, options, callback) {
    this.subscriptions.push({ topic, options });
    callback(null);
  }

  end() {
    this.ended = true;
  }
}

const disabled = new CommandWakeupRuntime({
  fetchTicket: async () => ({ enabled: false, fallbackPollMs: 6000 }),
});
await disabled.start();
assert.equal(disabled.getStatus().state, 'disabled');
assert.equal(disabled.getStatus().transport, 'http-polling');
disabled.stop();

const scheduledReconnects = [];
const transientFailure = new CommandWakeupRuntime({
  fetchTicket: async () => null,
  setTimer: (callback) => {
    scheduledReconnects.push(callback);
    return scheduledReconnects.length;
  },
  clearTimer: () => {},
  random: () => 0.5,
});
await transientFailure.start();
assert.equal(transientFailure.getStatus().state, 'error');
assert.equal(transientFailure.getStatus().lastError, 'MQTT_TICKET_UNAVAILABLE');
assert.equal(transientFailure.getStatus().reconnectAttempt, 1);
assert.equal(scheduledReconnects.length, 1, 'temporary ticket failures must schedule a fresh request');
transientFailure.stop();

const clients = [];
const connections = [];
const wakes = [];
const topic = 'preddita/v1/tenant/residencial-aurora/locker/ks1062-aurora/wake';
let nowIndex = 0;
const times = [
  '2026-07-16T12:00:00.000Z',
  '2026-07-16T12:00:01.000Z',
  '2026-07-16T12:00:02.000Z',
];
const runtime = new CommandWakeupRuntime({
  fetchTicket: async () => ({
    enabled: true,
    url: 'wss://example-ats.iot.sa-east-1.amazonaws.com/mqtt?X-Amz-Signature=secret',
    topic,
    clientId: 'preddita-locker-ks1062-aurora',
    qos: 1,
    healthyPollMs: 30000,
    fallbackPollMs: 6000,
  }),
  connect: (url, options) => {
    const client = new FakeMqttClient();
    clients.push(client);
    connections.push({ url, options });
    return client;
  },
  now: () => times[Math.min(nowIndex++, times.length - 1)],
});

await runtime.start({ onWake: (message) => wakes.push(message) });
assert.equal(runtime.getStatus().state, 'connecting');
clients[0].emit('connect');
assert.deepEqual(clients[0].subscriptions, [{ topic, options: { qos: 1 } }]);
assert.equal(runtime.getStatus().connected, true);
assert.equal(connections[0].options.clean, false);
assert.equal(connections[0].options.reconnectPeriod, 0);
assert.equal(JSON.stringify(runtime.getStatus()).includes('X-Amz-Signature'), false);

const validMessage = Buffer.from(JSON.stringify({
  schemaVersion: 1,
  eventId: 'wake-command-1',
  lockerId: 'ks1062-aurora',
  reason: 'command-created',
  occurredAt: '2026-07-16T11:59:59.000Z',
}));
clients[0].emit('message', topic, validMessage);
clients[0].emit('message', topic, validMessage);
clients[0].emit('message', topic, Buffer.from('{invalid'));
clients[0].emit('message', topic, Buffer.from(JSON.stringify({
  schemaVersion: 1,
  eventId: 'wake-wrong-locker',
  lockerId: 'another-locker',
})));
await Promise.resolve();
assert.equal(wakes.length, 1, 'duplicate and malformed wake-ups must be ignored');
assert.equal(wakes[0].eventId, 'wake-command-1');
assert.equal(runtime.getStatus().lastMessageAt, '2026-07-16T12:00:01.000Z');

runtime.stop();
assert.equal(clients[0].ended, true);
assert.equal(runtime.getStatus().connected, false);

console.log('PASS MQTT wake-up connection, QoS subscription, validation and deduplication');
