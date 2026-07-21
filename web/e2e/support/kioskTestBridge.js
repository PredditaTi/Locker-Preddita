export const LOCKER_STORAGE_KEY = 'preddita_entregas_locker_state_v1';

export function installRs485Bridge() {
  const doorStates = Array.from({ length: 24 }, () => 'closed');
  const bcc = (bytes) => bytes.reduce((value, byte) => value ^ (byte & 0xff), 0) & 0xff;
  const toHex = (bytes) => bytes
    .map((byte) => (byte & 0xff).toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
  const frame = (payload) => toHex([...payload, bcc(payload)]);
  const packedStates = () => {
    const bytes = new Array(3).fill(0);
    doorStates.forEach((state, index) => {
      if (state !== 'open') {
        const byteIndex = bytes.length - 1 - Math.floor(index / 8);
        bytes[byteIndex] |= 1 << (index % 8);
      }
    });
    return bytes;
  };

  window.__predditaTestHardware = {
    closeDoor(channel) {
      doorStates[channel - 1] = 'closed';
    },
    getDoorState(channel) {
      return doorStates[channel - 1];
    },
  };

  window.Android = {
    sendRS485(hexString) {
      const [command, board, channel, parameter] = String(hexString)
        .trim()
        .split(/\s+/)
        .map((part) => Number.parseInt(part, 16));
      let response;

      if (command === 0x80 && channel === 0) {
        response = frame([0x80, board, ...packedStates(), 0x33]);
      } else if (command === 0x80) {
        response = frame([0x80, board, channel, doorStates[channel - 1] === 'open' ? 0x00 : 0x11]);
      } else if ([0x8a, 0x7a, 0x7c, 0x7f, 0x9a].includes(command)) {
        doorStates[channel - 1] = 'open';
        response = command === 0x8a || command === 0x9a
          ? frame([command, board, channel, 0x00])
          : frame([command, board, channel, parameter]);
      } else if (command === 0x9b) {
        doorStates[channel - 1] = 'closed';
        response = frame([0x9b, board, channel, 0x11]);
      } else if (command === 0x9d) {
        doorStates.fill('open');
        response = frame([0x9e, board, ...packedStates()]);
      } else {
        response = frame([command, board, channel, parameter]);
      }

      window.setTimeout(() => window.onRS485Response(response), 5);
    },
    getBridgeVersion() {
      return 'E2E-RS485-BRIDGE';
    },
    isSerialOpen() {
      return true;
    },
    getSerialPath() {
      return '/dev/e2e-rs485';
    },
    getLastSerialError() {
      return '';
    },
  };
}

export function installAudioProbe() {
  window.__predditaAudioEvents = [];

  window.Audio = class AudioProbe {
    constructor(source) {
      this.source = source;
      this.currentTime = 0;
      this.volume = 1;
      this.listeners = new Map();
      window.__predditaAudioEvents.push({ type: 'create', source });
    }

    addEventListener(event, listener) {
      this.listeners.set(event, listener);
    }

    pause() {
      window.__predditaAudioEvents.push({ type: 'pause', source: this.source });
    }

    play() {
      window.__predditaAudioEvents.push({ type: 'play', source: this.source, volume: this.volume });
      return Promise.resolve();
    }
  };
}

export async function bootKiosk(page, options = {}) {
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  if (options.audioProbe) await page.addInitScript(installAudioProbe);
  await page.addInitScript(installRs485Bridge);
  await page.goto(options.url || '/');
  return browserErrors;
}

export async function closeTestDoor(page, channel) {
  await page.evaluate((door) => window.__predditaTestHardware.closeDoor(door), channel);
}

export async function getTestDoorState(page, channel) {
  return page.evaluate((door) => window.__predditaTestHardware.getDoorState(door), channel);
}

export async function readLockerState(page) {
  return page.evaluate(
    (storageKey) => JSON.parse(window.localStorage.getItem(storageKey) || '{}'),
    LOCKER_STORAGE_KEY
  );
}
