export const LOCKER_STORAGE_KEY = 'preddita_entregas_locker_state_v1';

export function installRs485Bridge() {
  const doorStates = Array.from({ length: 24 }, () => 'closed');
  const openCommands = [];
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
    setDoorState(channel, state) {
      doorStates[channel - 1] = state === 'open' ? 'open' : 'closed';
    },
    getDoorState(channel) {
      return doorStates[channel - 1];
    },
    getOpenCommands() {
      return [...openCommands];
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
        openCommands.push(channel);
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

export async function installStablePackageCamera(page) {
  await page.evaluate(() => {
    const stream = new MediaStream();
    const track = {
      stop() {
        window.__predditaPackageCamera.trackStopped = true;
      },
    };
    Object.defineProperty(stream, 'getTracks', {
      configurable: true,
      value: () => [track],
    });

    window.__predditaPackageCamera = {
      getUserMediaCalls: 0,
      trackStopped: false,
    };
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          window.__predditaPackageCamera.getUserMediaCalls += 1;
          return stream;
        },
      },
    });
    Object.defineProperties(window.HTMLMediaElement.prototype, {
      readyState: { configurable: true, get: () => 4 },
    });
    Object.defineProperties(window.HTMLVideoElement.prototype, {
      videoWidth: { configurable: true, get: () => 1280 },
      videoHeight: { configurable: true, get: () => 720 },
    });
    window.HTMLMediaElement.prototype.play = async () => {};
    window.CanvasRenderingContext2D.prototype.drawImage = () => {};
    window.CanvasRenderingContext2D.prototype.getImageData = (_x, _y, width, height) => {
      const pixels = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = ((y * width) + x) * 4;
          const value = (x + y) % 2 ? 220 : 40;
          pixels[offset] = value;
          pixels[offset + 1] = value;
          pixels[offset + 2] = value;
          pixels[offset + 3] = 255;
        }
      }
      return new ImageData(pixels, width, height);
    };
  });
}

export async function installPackageAnalyzerBridge(page, result = {}) {
  await page.evaluate((configuredResult) => {
    const approvedModelSha256 = /^[a-f0-9]{64}$/i.test(String(configuredResult.modelSha256 || ''))
      ? String(configuredResult.modelSha256).toLowerCase()
      : 'a'.repeat(64);
    const modelReady = configuredResult.status === 'ready';
    window.__predditaPackageAnalyzerRequests = [];
    window.PredditaPackageAnalyzer = {
      getBridgeVersion() {
        return 'PREDDITA-PACKAGE-ANALYZER-E2E';
      },
      getInfo() {
        return JSON.stringify({
          schemaVersion: 1,
          bridgeVersion: 'PREDDITA-PACKAGE-ANALYZER-E2E',
          modelVersion: 'package-pg-v1',
          modelAvailable: modelReady,
          modelSha256: modelReady ? approvedModelSha256 : '',
          reasonCode: modelReady ? '' : 'model-not-installed',
        });
      },
      analyze(rawRequest) {
        const request = JSON.parse(rawRequest);
        window.__predditaPackageAnalyzerRequests.push(request);
        window.setTimeout(() => window.dispatchEvent(new CustomEvent(
          'preddita-package-analysis',
          {
            detail: {
              schemaVersion: 1,
              requestId: request.requestId,
              status: 'uncertain',
              suggestedSize: '',
              confidence: null,
              captureQuality: request.captureQuality,
              modelVersion: 'package-pg-v1',
              modelSha256: modelReady ? approvedModelSha256 : '',
              inferenceMs: 25,
              reasonCode: 'model-not-installed',
              ...configuredResult,
            },
          }
        )), 10);
        return true;
      },
    };
  }, result);
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

export function installDiagnosticBridge() {
  let authorized = false;
  const display = {
    brightnessPercent: 70,
    mediaVolumePercent: 45,
    keepScreenOn: true,
  };
  window.__predditaDiagnosticEvents = [];
  window.__predditaPromptValue = '86420975';
  window.__predditaAlerts = [];
  window.prompt = () => window.__predditaPromptValue;
  window.alert = (message) => window.__predditaAlerts.push(String(message));

  window.PredditaDiagnostics = {
    getCredentialStatus() {
      return JSON.stringify({ provisioned: true, minimumLength: 8 });
    },
    verifyPin(pin) {
      authorized = pin === '86420975';
      window.__predditaDiagnosticEvents.push({ type: 'verify-pin', accepted: authorized });
      return authorized;
    },
    openProvisioning() {
      window.__predditaDiagnosticEvents.push({ type: 'open-provisioning' });
    },
    endSession() {
      authorized = false;
      window.__predditaDiagnosticEvents.push({ type: 'end-session' });
    },
    getStatus() {
      return JSON.stringify({
        authorized,
        serial: {
          open: true,
          path: '/dev/e2e-rs485',
          baudRate: 9600,
          reconnectCount: 0,
          lastFrameAt: new Date().toISOString(),
          errorCode: 'OK',
        },
        network: { online: true, transport: 'ethernet' },
        camera: { available: true, permission: 'granted' },
        display,
        storage: { freeBytes: 512 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024 },
        app: { versionName: '2.0.25-e2e', versionCode: 25 },
      });
    },
    setBrightnessPercent(value) {
      const accepted = authorized && Number.isInteger(value) && value >= 10 && value <= 100;
      if (accepted) display.brightnessPercent = value;
      window.__predditaDiagnosticEvents.push({ type: 'brightness', value, accepted });
      return accepted;
    },
    setMediaVolumePercent(value) {
      const accepted = authorized && Number.isInteger(value) && value >= 0 && value <= 65;
      if (accepted) display.mediaVolumePercent = value;
      window.__predditaDiagnosticEvents.push({ type: 'volume', value, accepted });
      return accepted;
    },
    setKeepScreenOn(value) {
      const accepted = authorized && typeof value === 'boolean';
      if (accepted) display.keepScreenOn = value;
      window.__predditaDiagnosticEvents.push({ type: 'keep-screen-on', value, accepted });
      return accepted;
    },
    retrySerial() {
      window.__predditaDiagnosticEvents.push({ type: 'retry-serial', accepted: authorized });
      return authorized;
    },
  };
}

export async function bootKiosk(page, options = {}) {
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  if (options.audioProbe) await page.addInitScript(installAudioProbe);
  if (options.diagnostics) await page.addInitScript(installDiagnosticBridge);
  await page.addInitScript(installRs485Bridge);
  await page.goto(options.url || '/');
  return browserErrors;
}

export async function startManualDelivery(page) {
  await page.getByRole('button', { name: /Entregar encomenda/i }).click();
  await page.getByRole('button', { name: /Entrega Manual/i }).click();
}

export async function closeTestDoor(page, channel) {
  await page.evaluate((door) => window.__predditaTestHardware.closeDoor(door), channel);
}

export async function getTestDoorState(page, channel) {
  return page.evaluate((door) => window.__predditaTestHardware.getDoorState(door), channel);
}

export async function getTestOpenCommands(page) {
  return page.evaluate(() => window.__predditaTestHardware.getOpenCommands());
}

export async function readLockerState(page) {
  return page.evaluate(
    (storageKey) => JSON.parse(window.localStorage.getItem(storageKey) || '{}'),
    LOCKER_STORAGE_KEY
  );
}
