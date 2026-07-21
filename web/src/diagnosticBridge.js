export const DIAGNOSTIC_BRIGHTNESS_MIN = 10;
export const DIAGNOSTIC_BRIGHTNESS_MAX = 100;
export const DIAGNOSTIC_VOLUME_MIN = 0;
export const DIAGNOSTIC_VOLUME_MAX = 65;

const DEVELOPMENT_PIN = import.meta.env?.DEV
  ? String(import.meta.env?.VITE_PREDDITA_DIAGNOSTIC_PIN ?? '').trim()
  : '';

let browserAuthorized = false;
let browserDisplayState = {
  brightnessPercent: 70,
  mediaVolumePercent: 45,
  keepScreenOn: true,
};

function getNativeBridge() {
  if (typeof window === 'undefined') return null;
  const bridge = window.PredditaDiagnostics;
  return bridge && typeof bridge.getCredentialStatus === 'function' ? bridge : null;
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function inRange(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function normalizeSerialCoordinator(value = {}) {
  const number = (field) => Number.isFinite(Number(value?.[field]))
    ? Math.max(0, Number(value[field]))
    : 0;
  return {
    state: String(value?.state ?? 'UNAVAILABLE'),
    queueDepth: number('queueDepth'),
    maxQueueDepth: number('maxQueueDepth'),
    inFlight: Boolean(value?.inFlight),
    blockedActuations: number('blockedActuations'),
    submitted: number('submitted'),
    completed: number('completed'),
    rejected: number('rejected'),
    writes: number('writes'),
    readRetries: number('readRetries'),
    timeouts: number('timeouts'),
    invalidFrames: number('invalidFrames'),
    discardedBytes: number('discardedBytes'),
    mismatchedFrames: number('mismatchedFrames'),
    reconnections: number('reconnections'),
    ioFailures: number('ioFailures'),
    unknownActuations: number('unknownActuations'),
    lastQueueWaitMs: number('lastQueueWaitMs'),
    maxQueueWaitMs: number('maxQueueWaitMs'),
    lastValidResponseAt: String(value?.lastValidResponseAt ?? ''),
  };
}

function getBrowserStorageMetrics() {
  if (typeof window === 'undefined' || !window.localStorage) return { journalBytes: 0 };
  let journalBytes = 0;
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index) || '';
      if (!key.startsWith('preddita_')) continue;
      const value = window.localStorage.getItem(key) || '';
      journalBytes += new Blob([key, value]).size;
    }
  } catch {
    return { journalBytes: 0 };
  }
  return { journalBytes };
}

export function getDiagnosticCredentialStatus() {
  const bridge = getNativeBridge();
  if (bridge) {
    const parsed = parseJson(bridge.getCredentialStatus(), { available: true });
    return {
      available: true,
      provisioned: Boolean(parsed.provisioned),
      source: 'android',
      minimumLength: Number(parsed.minimumLength) || 8,
    };
  }

  return {
    available: Boolean(import.meta.env?.DEV),
    provisioned: Boolean(DEVELOPMENT_PIN),
    source: 'development',
    minimumLength: 8,
  };
}

export function verifyDiagnosticCredential(pin) {
  const entered = String(pin ?? '').trim();
  const bridge = getNativeBridge();
  if (bridge && typeof bridge.verifyPin === 'function') {
    try {
      return Boolean(bridge.verifyPin(entered));
    } catch {
      return false;
    }
  }

  const valid = Boolean(import.meta.env?.DEV) && Boolean(DEVELOPMENT_PIN) && entered === DEVELOPMENT_PIN;
  browserAuthorized = valid;
  return valid;
}

export function openDiagnosticProvisioning() {
  const bridge = getNativeBridge();
  if (!bridge || typeof bridge.openProvisioning !== 'function') return false;
  try {
    bridge.openProvisioning();
    return true;
  } catch {
    return false;
  }
}

export function endDiagnosticSession() {
  browserAuthorized = false;
  const bridge = getNativeBridge();
  if (!bridge || typeof bridge.endSession !== 'function') return;
  try {
    bridge.endSession();
  } catch {
    // Closing the UI must not be blocked by a native bridge failure.
  }
}

export function getTechnicalStatus() {
  const bridge = getNativeBridge();
  if (bridge && typeof bridge.getStatus === 'function') {
    const parsed = parseJson(bridge.getStatus(), { available: true, authorized: false });
    return {
      available: true,
      authorized: Boolean(parsed.authorized),
      serial: {
        open: Boolean(parsed.serial?.open),
        path: String(parsed.serial?.path ?? ''),
        baudRate: Number(parsed.serial?.baudRate) || 0,
        reconnectCount: Number(parsed.serial?.reconnectCount) || 0,
        lastFrameAt: String(parsed.serial?.lastFrameAt ?? ''),
        errorCode: String(parsed.serial?.errorCode ?? ''),
        coordinator: normalizeSerialCoordinator(parsed.serial?.coordinator),
      },
      network: {
        online: Boolean(parsed.network?.online),
        transport: String(parsed.network?.transport ?? 'unknown'),
      },
      camera: {
        available: Boolean(parsed.camera?.available),
        permission: String(parsed.camera?.permission ?? 'unknown'),
      },
      display: {
        brightnessPercent: Number(parsed.display?.brightnessPercent) || browserDisplayState.brightnessPercent,
        mediaVolumePercent: Number.isFinite(Number(parsed.display?.mediaVolumePercent))
          ? Number(parsed.display.mediaVolumePercent)
          : browserDisplayState.mediaVolumePercent,
        keepScreenOn: Boolean(parsed.display?.keepScreenOn),
      },
      storage: {
        freeBytes: Number(parsed.storage?.freeBytes) || 0,
        totalBytes: Number(parsed.storage?.totalBytes) || 0,
        journalBytes: getBrowserStorageMetrics().journalBytes,
      },
      app: {
        versionName: String(parsed.app?.versionName ?? ''),
        versionCode: Number(parsed.app?.versionCode) || 0,
      },
      errorCode: String(parsed.errorCode ?? ''),
    };
  }

  return {
    available: false,
    authorized: browserAuthorized,
    serial: {
      open: true,
      path: '/dev/ttyS5',
      baudRate: 9600,
      reconnectCount: 0,
      lastFrameAt: '',
      errorCode: 'SIMULATED',
      coordinator: normalizeSerialCoordinator({ state: 'READY' }),
    },
    network: {
      online: typeof navigator !== 'undefined' ? navigator.onLine : true,
      transport: 'browser',
    },
    camera: {
      available: Boolean(typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia),
      permission: 'browser',
    },
    display: { ...browserDisplayState },
    storage: { freeBytes: 0, totalBytes: 0, ...getBrowserStorageMetrics() },
    app: { versionName: 'browser', versionCode: 0 },
    errorCode: '',
  };
}

export function setDiagnosticBrightness(value) {
  if (typeof value !== 'number') return false;
  const percent = value;
  if (!inRange(percent, DIAGNOSTIC_BRIGHTNESS_MIN, DIAGNOSTIC_BRIGHTNESS_MAX)) return false;
  const bridge = getNativeBridge();
  if (bridge && typeof bridge.setBrightnessPercent === 'function') {
    try {
      return Boolean(bridge.setBrightnessPercent(percent));
    } catch {
      return false;
    }
  }
  if (!browserAuthorized) return false;
  browserDisplayState = { ...browserDisplayState, brightnessPercent: percent };
  return true;
}

export function setDiagnosticVolume(value) {
  if (typeof value !== 'number') return false;
  const percent = value;
  if (!inRange(percent, DIAGNOSTIC_VOLUME_MIN, DIAGNOSTIC_VOLUME_MAX)) return false;
  const bridge = getNativeBridge();
  if (bridge && typeof bridge.setMediaVolumePercent === 'function') {
    try {
      return Boolean(bridge.setMediaVolumePercent(percent));
    } catch {
      return false;
    }
  }
  if (!browserAuthorized) return false;
  browserDisplayState = { ...browserDisplayState, mediaVolumePercent: percent };
  return true;
}

export function setDiagnosticKeepScreenOn(enabled) {
  if (typeof enabled !== 'boolean') return false;
  const bridge = getNativeBridge();
  if (bridge && typeof bridge.setKeepScreenOn === 'function') {
    try {
      return Boolean(bridge.setKeepScreenOn(enabled));
    } catch {
      return false;
    }
  }
  if (!browserAuthorized) return false;
  browserDisplayState = { ...browserDisplayState, keepScreenOn: enabled };
  return true;
}

export function retryDiagnosticSerial() {
  const bridge = getNativeBridge();
  if (bridge && typeof bridge.retrySerial === 'function') {
    try {
      return Boolean(bridge.retrySerial());
    } catch {
      return false;
    }
  }
  return browserAuthorized;
}
