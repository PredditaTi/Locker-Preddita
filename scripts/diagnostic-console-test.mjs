import assert from 'node:assert/strict';

const calls = [];
let authorized = false;
globalThis.window = {
  localStorage: {
    length: 0,
    key: () => null,
    getItem: () => null,
  },
  PredditaDiagnostics: {
    getCredentialStatus() {
      return JSON.stringify({ provisioned: true, minimumLength: 8 });
    },
    verifyPin(pin) {
      calls.push(['verifyPin', pin]);
      authorized = pin === '86420975';
      return authorized;
    },
    endSession() {
      calls.push(['endSession']);
      authorized = false;
    },
    getStatus() {
      return JSON.stringify({
        authorized,
        serial: {
          open: true,
          path: '/dev/ttyS5',
          baudRate: 9600,
          errorCode: 'OK',
          coordinator: {
            state: 'READY',
            queueDepth: 2,
            maxQueueDepth: 5,
            readRetries: 3,
            invalidFrames: 4,
            blockedActuations: 1,
            lastValidResponseAt: '2026-07-21T12:00:00.000Z',
            rawFrame: '8A 01 04 33 BC',
          },
        },
        network: { online: true, transport: 'ethernet' },
        camera: { available: true, permission: 'granted' },
        display: { brightnessPercent: 70, mediaVolumePercent: 45, keepScreenOn: true },
        storage: { freeBytes: 1024, totalBytes: 2048 },
        app: { versionName: '2.0.25', versionCode: 25 },
      });
    },
    setBrightnessPercent(value) {
      calls.push(['brightness', value]);
      return authorized;
    },
    setMediaVolumePercent(value) {
      calls.push(['volume', value]);
      return authorized;
    },
    setKeepScreenOn(value) {
      calls.push(['keepScreenOn', value]);
      return authorized;
    },
    retrySerial() {
      calls.push(['retrySerial']);
      return authorized;
    },
  },
};

const diagnostics = await import('../web/src/diagnosticBridge.js');
const { createInitialState, recordAuditEvent } = await import('../web/src/lockerWorkflow.js');

assert.deepEqual(diagnostics.getDiagnosticCredentialStatus(), {
  available: true,
  provisioned: true,
  source: 'android',
  minimumLength: 8,
});
assert.equal(diagnostics.verifyDiagnosticCredential('wrong-pin'), false);
assert.equal(diagnostics.setDiagnosticBrightness(70), false, 'Controls require an authorized session');
assert.equal(diagnostics.verifyDiagnosticCredential('86420975'), true);

const status = diagnostics.getTechnicalStatus();
assert.equal(status.authorized, true);
assert.equal(status.serial.path, '/dev/ttyS5');
assert.equal(status.serial.coordinator.state, 'READY');
assert.equal(status.serial.coordinator.queueDepth, 2);
assert.equal(status.serial.coordinator.invalidFrames, 4);
assert.equal(Object.hasOwn(status.serial.coordinator, 'rawFrame'), false, 'Raw frames must not cross diagnostics');
assert.equal(status.network.transport, 'ethernet');

assert.equal(diagnostics.setDiagnosticBrightness(10), true);
assert.equal(diagnostics.setDiagnosticBrightness(100), true);
assert.equal(diagnostics.setDiagnosticBrightness(9), false);
assert.equal(diagnostics.setDiagnosticBrightness(101), false);
assert.equal(diagnostics.setDiagnosticBrightness('70'), false, 'Numeric text must not cross the bridge');
assert.equal(diagnostics.setDiagnosticBrightness(Number.NaN), false);

assert.equal(diagnostics.setDiagnosticVolume(0), true);
assert.equal(diagnostics.setDiagnosticVolume(65), true);
assert.equal(diagnostics.setDiagnosticVolume(-1), false);
assert.equal(diagnostics.setDiagnosticVolume(66), false);
assert.equal(diagnostics.setDiagnosticVolume('45'), false, 'Numeric text must not cross the bridge');

assert.equal(diagnostics.setDiagnosticKeepScreenOn(true), true);
assert.equal(diagnostics.setDiagnosticKeepScreenOn('true'), false, 'Boolean text must not cross the bridge');
assert.equal(diagnostics.retryDiagnosticSerial(), true);

assert.deepEqual(calls.filter(([name]) => name === 'brightness').map(([, value]) => value), [70, 10, 100]);
assert.deepEqual(calls.filter(([name]) => name === 'volume').map(([, value]) => value), [0, 65]);
assert.equal(Object.hasOwn(diagnostics, 'executeCommand'), false);
assert.equal(Object.hasOwn(diagnostics, 'readPath'), false);
assert.equal(Object.hasOwn(diagnostics, 'runShell'), false);

diagnostics.endDiagnosticSession();
assert.equal(authorized, false);
assert.equal(diagnostics.setDiagnosticBrightness(70), false);

let auditedState = createInitialState();
for (let channel = 1; channel <= 24; channel += 1) {
  auditedState = recordAuditEvent(auditedState, 'diagnostic-door-test', `Porta ${channel} iniciada.`, {
    actor: 'technical-local',
    channel,
    outcome: 'started',
  });
  auditedState = recordAuditEvent(auditedState, 'diagnostic-door-test', `Porta ${channel} concluida.`, {
    actor: 'technical-local',
    channel,
    outcome: 'passed',
  });
}
assert.equal(auditedState.auditTrail.filter((event) => event.kind === 'diagnostic-door-test').length, 48);

console.log('diagnostic-console-test: bridge allowlist and limits passed');
