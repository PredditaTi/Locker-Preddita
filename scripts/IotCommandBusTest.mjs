import assert from 'node:assert/strict';

import {
  buildIotWakeupTopic,
  createIotCommandBus,
  createIotDeviceSessionPolicy,
  getIotStartupConfigErrors,
  normalizeIotConfig,
} from '../admin-online/iotCommandBus.mjs';

const config = normalizeIotConfig({
  PREDDITA_IOT_MODE: 'aws-iot',
  PREDDITA_IOT_REGION: 'sa-east-1',
  PREDDITA_IOT_ENDPOINT: 'a1b2c3d4e5f6-ats.iot.sa-east-1.amazonaws.com',
  PREDDITA_IOT_DEVICE_ROLE_ARN: 'arn:aws:iam::123456789012:role/preddita-locker-mqtt',
  PREDDITA_IOT_TOPIC_PREFIX: 'preddita/v1',
  PREDDITA_IOT_TICKET_TTL_SECONDS: '900',
});

assert.deepEqual(getIotStartupConfigErrors(config), []);
assert.equal(
  buildIotWakeupTopic(config, 'residencial-aurora', 'ks1062-aurora'),
  'preddita/v1/tenant/residencial-aurora/locker/ks1062-aurora/wake',
);
assert.throws(
  () => buildIotWakeupTopic(config, 'tenant/other', 'ks1062-aurora'),
  /tenantId/,
);

const topic = buildIotWakeupTopic(config, 'residencial-aurora', 'ks1062-aurora');
const clientId = 'preddita-locker-ks1062-aurora';
const policy = createIotDeviceSessionPolicy({
  region: config.region,
  accountId: '123456789012',
  clientId,
  topic,
});
assert.deepEqual(policy.Statement.map((statement) => statement.Action), [
  'iot:Connect',
  'iot:Subscribe',
  'iot:Receive',
]);
assert.equal(JSON.stringify(policy).includes('*'), false, 'device policy must not contain wildcard resources');
assert.equal(policy.Statement[0].Resource.endsWith(`:client/${clientId}`), true);
assert.equal(policy.Statement[1].Resource.endsWith(`:topicfilter/${topic}`), true);
assert.equal(policy.Statement[2].Resource.endsWith(`:topic/${topic}`), true);

const published = [];
const assumeRoleInputs = [];
const presignInputs = [];
const nowMs = Date.parse('2026-07-16T12:00:00.000Z');
const bus = createIotCommandBus({
  config,
  now: () => nowMs,
  createEventId: () => 'wake-test-1',
  clients: {
    iot: {
      send: async (command) => {
        published.push(command.input);
        return {};
      },
    },
    sts: {
      send: async (command) => {
        assumeRoleInputs.push(command.input);
        return {
          Credentials: {
            AccessKeyId: 'ASIATEST',
            SecretAccessKey: 'temporary-secret',
            SessionToken: 'temporary-token',
            Expiration: new Date(nowMs + 900000),
          },
        };
      },
    },
  },
  presign: async (input) => {
    presignInputs.push(input);
    return 'wss://a1b2c3d4e5f6-ats.iot.sa-east-1.amazonaws.com/mqtt?X-Amz-Signature=test';
  },
});

const publishResult = await bus.publishWakeup({
  tenantId: 'residencial-aurora',
  lockerId: 'ks1062-aurora',
  reason: 'command-created',
});
assert.equal(publishResult.ok, true);
assert.equal(published[0].topic, topic);
assert.equal(published[0].qos, 1);
assert.equal(published[0].retain, false);
assert.deepEqual(JSON.parse(Buffer.from(published[0].payload).toString('utf8')), {
  schemaVersion: 1,
  eventId: 'wake-test-1',
  lockerId: 'ks1062-aurora',
  reason: 'command-created',
  occurredAt: '2026-07-16T12:00:00.000Z',
});

const ticket = await bus.createDeviceTicket({
  tenantId: 'residencial-aurora',
  lockerId: 'ks1062-aurora',
});
assert.equal(ticket.enabled, true);
assert.equal(ticket.topic, topic);
assert.equal(ticket.clientId, clientId);
assert.equal(ticket.qos, 1);
assert.equal(ticket.url.startsWith('wss://'), true);
assert.equal(assumeRoleInputs[0].DurationSeconds, 900);
assert.deepEqual(JSON.parse(assumeRoleInputs[0].Policy), policy);
assert.equal(presignInputs[0].credentials.accessKeyId, 'ASIATEST');
assert.equal(JSON.stringify(bus.getStatus()).includes('temporary-secret'), false);
assert.equal(JSON.stringify(bus.getStatus()).includes('X-Amz-Signature'), false);

const disabledBus = createIotCommandBus({ config: normalizeIotConfig({}) });
assert.deepEqual(await disabledBus.createDeviceTicket({}), {
  enabled: false,
  mode: 'disabled',
  fallbackPollMs: 6000,
});

console.log('PASS AWS IoT wake-up policy, QoS 1 publish and temporary device ticket');
