import assert from 'node:assert/strict';

const submissions = [];
globalThis.window = {
  Android: {
    sendRS485Command(executionId, hexFrame) {
      submissions.push({ executionId, hexFrame });
      const parts = hexFrame.split(/\s+/).map((value) => Number.parseInt(value, 16));
      const command = parts[0];
      const board = parts[1];
      const channel = parts[2];
      setTimeout(() => {
        if (command === 0x8a) {
          window.onRS485CommandResult({
            executionId,
            operation: 'actuation',
            ok: false,
            error: 'ACTUATION_OUTCOME_UNKNOWN',
            attempts: 1,
            executionOutcomeUnknown: true,
          });
          return;
        }
        const payload = [command, board, channel, 0x11];
        const checksum = payload.reduce((value, byte) => value ^ byte, 0);
        window.onRS485CommandResult({
          executionId,
          operation: 'read',
          ok: true,
          error: '',
          hex: [...payload, checksum].map((value) => value.toString(16).padStart(2, '0')).join(' '),
          attempts: 2,
          queueWaitMs: 7,
          durationMs: 30,
          executionOutcomeUnknown: false,
        });
      }, 0);
      return true;
    },
    getBridgeVersion: () => 'PREDDITA-BRIDGE-1.8.0',
    isSerialOpen: () => true,
    getSerialPath: () => '/dev/ttyS5',
    getLastSerialError: () => 'OK',
    getSerialCoordinatorStatus: () => JSON.stringify({
      state: 'READY',
      queueDepth: 0,
      readRetries: 1,
      invalidFrames: 2,
    }),
  },
};

const serial = await import(`../web/src/serial.js?native-bridge-test=${Date.now()}`);
const readResult = await serial.sendFrame(serial.frame(0x80, 1, 4, 0x33));
assert.equal(readResult.ok, true);
assert.equal(readResult.operation, 'read');
assert.equal(readResult.attempts, 2);
assert.equal(readResult.queueWaitMs, 7);
assert.match(readResult.executionId, /^rs485-[a-z0-9]+-[a-z0-9]+$/);
assert.equal(submissions[0].executionId, readResult.executionId);

const actuationResult = await serial.sendFrame(serial.frame(0x8a, 1, 4, 0x33));
assert.equal(actuationResult.ok, false);
assert.equal(actuationResult.error, 'ACTUATION_OUTCOME_UNKNOWN');
assert.equal(actuationResult.executionOutcomeUnknown, true);
assert.notEqual(submissions[0].executionId, submissions[1].executionId);

const hardware = serial.default.getHardwareInfo();
assert.equal(hardware.bridgeVersion, 'PREDDITA-BRIDGE-1.8.0');
assert.equal(hardware.serialCoordinator.state, 'READY');
assert.equal(hardware.serialCoordinator.invalidFrames, 2);

console.log('PREDDITA_SERIAL_NATIVE_BRIDGE_OK');
