/**
 * PREDDITA Smart Locker - Serial Bridge
 *
 * RS-485 abstraction that works in two modes:
 *   1. Native APK mode through window.Android
 *   2. Browser simulation with in-memory locker state
 */

const SIM_MIN_DOORS = 24;
const DEFAULT_PROTOCOL = 'manual2025';
const DEFAULT_ACTION_MODE = 'unlock';
const ZYSJ_SAFE_MODE = true;
export const ZYSJ_GPIO_PINS = [1, 2, 3, 4, 5, 6, 24];

export const HARDWARE_BACKENDS = {
  rs485: {
    id: 'rs485',
    label: 'RS-485',
    description: 'Direct lock-board protocol over the serial line.',
  },
  zysj: {
    id: 'zysj',
    label: 'GPIO ZYSJ',
    description: 'Vendor system service for GPIO and output-channel diagnostics.',
  },
};

export const PROTOCOLS = {
  manual2025: {
    id: 'manual2025',
    label: 'Manual 2025',
    description: 'Uses the 2025 lock-panel document as the primary source.',
    unlockParam: 0x33,
    feedbackCommand: 0x8d,
    feedbackChannel: 0x01,
    feedbackOnValue: 0x01,
    feedbackOffValue: 0x00,
    openAllChannel: 0x01,
  },
  legacyAlpha: {
    id: 'legacyAlpha',
    label: 'Legacy 0x11',
    description: 'Keeps the older unlock payload used by the first test build.',
    unlockParam: 0x11,
    feedbackCommand: 0x81,
    feedbackChannel: null,
    feedbackOnValue: 0x11,
    feedbackOffValue: 0x00,
    openAllChannel: 0x01,
  },
};

export const ACTION_MODES = {
  unlock: {
    id: 'unlock',
    label: 'Padrao 8A',
    description: 'Single unlock using the main 0x8A command.',
  },
  pulse3: {
    id: 'pulse3',
    label: 'Pulso 3x',
    description: 'Uses command 0x7C with three unlock pulses.',
  },
  motorA: {
    id: 'motorA',
    label: 'Motor A',
    description: 'Uses command 0x7A for A-type motor locks.',
  },
  limitOpen: {
    id: 'limitOpen',
    label: 'Limit 0x11',
    description: 'Uses command 0x7F with 0x11 as the limit state.',
  },
};

export const PROTOCOL_OPTIONS = Object.values(PROTOCOLS);
export const ACTION_MODE_OPTIONS = Object.values(ACTION_MODES);
export const HARDWARE_BACKEND_OPTIONS = Object.values(HARDWARE_BACKENDS);

const isNative = () => typeof window !== 'undefined' && !!window.Android;
const getAndroidBridge = () =>
  typeof window !== 'undefined' && window.Android ? window.Android : null;
const normalizeOptionalNativeInt = (value) =>
  Number.isFinite(value) && value >= 0 ? value : null;

export const bcc = (bytes) =>
  bytes.reduce((acc, value) => (acc ^ (value & 0xff)) & 0xff, 0);

export const hex = (value) =>
  ((value ?? 0) & 0xff).toString(16).toUpperCase().padStart(2, '0');

export const frame = (command, board, channel, param) => {
  const payload = [command, board, channel, param];
  return [...payload, bcc(payload)];
};

export const formatHex = (bytes) => bytes.map(hex).join(' ');

export const parseHexFrame = (hexString) =>
  String(hexString ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((chunk) => Number.parseInt(chunk, 16))
    .filter((value) => Number.isFinite(value));

export const validateFrame = (bytes) =>
  Array.isArray(bytes) &&
  bytes.length > 1 &&
  bcc(bytes.slice(0, -1)) === bytes[bytes.length - 1];

export function getProtocolProfile(profileId = DEFAULT_PROTOCOL) {
  return PROTOCOLS[profileId] ?? PROTOCOLS[DEFAULT_PROTOCOL];
}

export function parseGpioSnapshot(snapshot) {
  return String(snapshot ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((accumulator, entry) => {
      const [pinPart, valuePart] = entry.split('=');
      const pin = Number.parseInt(pinPart, 10);
      const value = Number.parseInt(valuePart, 10);

      if (Number.isFinite(pin)) {
        accumulator[pin] = Number.isFinite(value) ? value : -9999;
      }

      return accumulator;
    }, {});
}

export function createActuationFrame(
  board,
  channel,
  actionModeId = DEFAULT_ACTION_MODE,
  profileId = DEFAULT_PROTOCOL
) {
  const profile = getProtocolProfile(profileId);

  switch (actionModeId) {
    case 'pulse3':
      return frame(0x7c, board, channel, 0x03);
    case 'motorA':
      return frame(0x7a, board, channel, 0x33);
    case 'limitOpen':
      return frame(0x7f, board, channel, 0x11);
    case 'unlock':
    default:
      return frame(0x8a, board, channel, profile.unlockParam);
  }
}

export function createCommandSet(profileId = DEFAULT_PROTOCOL) {
  const profile = getProtocolProfile(profileId);

  const setFeedback = (board, enabled) => {
    if (profile.feedbackCommand === 0x8d) {
      return frame(
        0x8d,
        board,
        profile.feedbackChannel,
        enabled ? profile.feedbackOnValue : profile.feedbackOffValue
      );
    }

    return frame(
      0x81,
      board,
      enabled ? profile.feedbackOnValue : profile.feedbackOffValue,
      0xcc
    );
  };

  return {
    actuate: (board, channel, actionModeId = DEFAULT_ACTION_MODE) =>
      createActuationFrame(board, channel, actionModeId, profileId),
    unlock: (board, channel) => frame(0x8a, board, channel, profile.unlockParam),
    readStatus: (board, channel) => frame(0x80, board, channel, 0x33),
    readAll: (board) => frame(0x80, board, 0x00, 0x33),
    setFeedback,
    queryFW: (board) => frame(0x82, board, 0x00, 0x22),
    queryUID: (board) => frame(0x82, board, 0x00, 0x44),
    normallyOpen: (board, channel) => frame(0x9a, board, channel, 0x33),
    close: (board, channel) => frame(0x9b, board, channel, 0x33),
    openAll: (board) => frame(0x9d, board, profile.openAllChannel, 0x33),
    setTimeout: (board, channel, seconds) => frame(0x7e, board, channel, seconds),
  };
}

export const COMMANDS = createCommandSet();

export function packedBytesToBitString(stateBytes) {
  return stateBytes
    .map((value) => (value & 0xff).toString(2).padStart(8, '0'))
    .join('');
}

export function decodePackedStates(stateBytes, options = {}) {
  const { channelCount = null, alignment = 'right' } = options;
  const binary = packedBytesToBitString(stateBytes);
  const safeCount =
    Number.isFinite(channelCount) && channelCount > 0
      ? Math.min(channelCount, binary.length)
      : binary.length;

  return Array.from({ length: safeCount }, (_, index) => {
    const bit =
      alignment === 'left'
        ? binary[index] ?? '1'
        : binary[binary.length - 1 - index] ?? '1';
    const isOpen = bit === '0';
    return {
      channel: index + 1,
      bit,
      state: isOpen ? 'open' : 'closed',
      detail: isOpen
        ? 'Aberta confirmada pela placa'
        : 'Fechada ou sem retorno de sensor',
      ambiguous: !isOpen,
    };
  });
}

function parseSingleStateByte(command, stateByte) {
  if (stateByte === 0x33) {
    return {
      type: 'echo',
      command,
      stateByte,
      detail: 'Frame de consulta ecoado antes da resposta da placa.',
    };
  }

  // Field validation on the installed controller shows 0x00 when the door sensor
  // is really open and 0x11 when the door is closed.
  if (stateByte === 0x00) {
    return {
      type: 'single',
      state: 'open',
      detail: 'Aberta confirmada pela placa',
      ambiguous: false,
      statusKnown: true,
    };
  }

  if (stateByte === 0x11) {
    return {
      type: 'single',
      state: 'closed',
      detail: 'Fechada ou sem retorno de sensor',
      ambiguous: true,
      statusKnown: true,
    };
  }

  return {
    type: 'raw',
    stateByte,
    detail: `Valor de status nao documentado: 0x${hex(stateByte)}`,
  };
}

function encodePackedStates(states) {
  const byteCount = Math.max(3, Math.ceil(states.length / 8));
  const bytes = new Array(byteCount).fill(0);

  for (let index = 0; index < states.length; index += 1) {
    if (states[index] !== 'open') {
      const byteIndex = byteCount - 1 - Math.floor(index / 8);
      const bitIndex = index % 8;
      bytes[byteIndex] |= 1 << bitIndex;
    }
  }

  return bytes;
}

export function parseResponse(hexString) {
  const bytes = parseHexFrame(hexString);
  if (bytes.length === 0) {
    return null;
  }

  const command = bytes[0];
  const board = bytes[1];
  const validChecksum = validateFrame(bytes);

  if ([0x80, 0x8a, 0x9a, 0x9b].includes(command) && bytes.length === 5) {
    const parsedState = parseSingleStateByte(command, bytes[3]);

    if (parsedState.type === 'echo') {
      return {
        type: 'echo',
        command,
        board,
        channel: bytes[2],
        stateByte: bytes[3],
        detail: parsedState.detail,
        validChecksum,
        bytes,
      };
    }

    if (parsedState.type === 'single') {
      return {
        type: 'single',
        command,
        board,
        channel: bytes[2],
        stateByte: bytes[3],
        state: parsedState.state,
        detail: parsedState.detail,
        ambiguous: parsedState.ambiguous,
        statusKnown: parsedState.statusKnown,
        validChecksum,
        bytes,
      };
    }

    return {
      type: 'raw',
      command,
      board,
      channel: bytes[2],
      stateByte: bytes[3],
      detail: parsedState.detail,
      validChecksum,
      bytes,
    };
  }

  if ([0x7a, 0x7c, 0x7e, 0x7f, 0x81].includes(command) && bytes.length === 5) {
    return {
      type: 'ack',
      command,
      board,
      channel: bytes[2],
      value: bytes[3],
      validChecksum,
      bytes,
    };
  }

  if (command === 0x8d && bytes.length === 5) {
    return {
      type: 'autoUpload',
      command,
      board,
      channel: bytes[2],
      enabled: bytes[3] === 0x01,
      validChecksum,
      bytes,
    };
  }

  if (command === 0x82 && bytes.length === 5) {
    return {
      type: bytes[3] === 0xab ? 'firmware' : 'identity',
      command,
      board,
      value: bytes[3],
      text: `0x${hex(bytes[3])}`,
      validChecksum,
      bytes,
    };
  }

  if (command === 0x80 && bytes.length >= 7) {
    const stateBytes =
      bytes[bytes.length - 2] === 0x33 ? bytes.slice(2, -2) : bytes.slice(2, -1);

    return {
      type: 'all',
      command,
      board,
      stateBytes,
      bitString: packedBytesToBitString(stateBytes),
      packed: stateBytes.map(hex).join(' '),
      states: decodePackedStates(stateBytes),
      validChecksum,
      bytes,
    };
  }

  if (command === 0x9e && bytes.length >= 6) {
    const stateBytes = bytes.slice(2, -1);

    return {
      type: 'all',
      command,
      board,
      stateBytes,
      bitString: packedBytesToBitString(stateBytes),
      packed: stateBytes.map(hex).join(' '),
      states: decodePackedStates(stateBytes),
      validChecksum,
      bytes,
    };
  }

  return {
    type: 'raw',
    command,
    board,
    validChecksum,
    bytes,
  };
}

export function responseMatchesRequest(parsed, requestBytes) {
  if (!parsed || parsed.type === 'echo' || parsed.validChecksum !== true) return false;
  if (!Array.isArray(requestBytes) || requestBytes.length < 4) return false;

  const requestCommand = requestBytes[0] & 0xff;
  const expectedResponseCommand = requestCommand === 0x9d ? 0x9e : requestCommand;
  if (parsed.command !== expectedResponseCommand) return false;
  if (parsed.board !== (requestBytes[1] & 0xff)) return false;

  const requestChannel = requestBytes[2] & 0xff;
  if (
    requestChannel !== 0 &&
    Number.isFinite(parsed.channel) &&
    parsed.channel !== requestChannel
  ) {
    return false;
  }

  return true;
}

const responseCallbacks = new Map();
let responseId = 0;
let sendQueue = Promise.resolve();

if (typeof window !== 'undefined') {
  window.onRS485Response = (hexString) => {
    const [id, callback] = responseCallbacks.entries().next().value ?? [];
    if (callback) {
      const handled = callback({ ok: true, hex: hexString });
      if (handled !== false) {
        responseCallbacks.delete(id);
      }
    }
  };

  window.onRS485Error = (message) => {
    const [id, callback] = responseCallbacks.entries().next().value ?? [];
    if (callback) {
      responseCallbacks.delete(id);
      callback({ ok: false, error: message });
    }
  };
}

const simulationBoards = new Map();

function getSimBoard(board) {
  if (!simulationBoards.has(board)) {
    simulationBoards.set(board, {
      firmware: 0xab,
      autoUpload: true,
      doors: Array.from({ length: SIM_MIN_DOORS }, () => 'closed'),
      gpio: Object.fromEntries(ZYSJ_GPIO_PINS.map((pin) => [pin, 0])),
      outputChannel: 0,
      mcuVersion: -2,
    });
  }

  return simulationBoards.get(board);
}

function buildSingleStateFrame(command, board, channel, state) {
  const stateByte = state === 'open' ? 0x00 : 0x11;
  const payload = [command, board, channel, stateByte];
  return formatHex([...payload, bcc(payload)]);
}

function buildAckFrame(command, board, channel, value = 0x01) {
  const payload = [command, board, channel, value];
  return formatHex([...payload, bcc(payload)]);
}

function buildPackedStateFrame(command, board, doorStates) {
  const packed = encodePackedStates(doorStates);

  if (command === 0x80) {
    const payload = [command, board, ...packed, 0x33];
    return formatHex([...payload, bcc(payload)]);
  }

  const payload = [command, board, ...packed];
  return formatHex([...payload, bcc(payload)]);
}

function simulateResponse(bytes) {
  const [command, board, channel, param] = bytes;
  const simBoard = getSimBoard(board);

  switch (command) {
    case 0x80:
      if (channel === 0x00) {
        return buildPackedStateFrame(0x80, board, simBoard.doors);
      }
      return buildSingleStateFrame(
        0x80,
        board,
        channel,
        simBoard.doors[channel - 1] ?? 'closed'
      );

    case 0x8a:
    case 0x7a:
    case 0x7c:
    case 0x7f:
      simBoard.doors[channel - 1] = 'open';
      if (command === 0x8a) {
        return buildSingleStateFrame(0x8a, board, channel, 'open');
      }
      return buildAckFrame(command, board, channel, param);

    case 0x9a:
      simBoard.doors[channel - 1] = 'open';
      return buildSingleStateFrame(0x9a, board, channel, 'open');

    case 0x9b:
      simBoard.doors[channel - 1] = 'closed';
      return buildSingleStateFrame(0x9b, board, channel, 'closed');

    case 0x9d:
      simBoard.doors = simBoard.doors.map(() => 'open');
      return buildPackedStateFrame(0x9e, board, simBoard.doors);

    case 0x8d: {
      simBoard.autoUpload = param === 0x01;
      const payload = [0x8d, board, channel, simBoard.autoUpload ? 0x01 : 0x00];
      return formatHex([...payload, bcc(payload)]);
    }

    case 0x81: {
      simBoard.autoUpload = param === 0x11;
      return buildAckFrame(0x81, board, channel, param);
    }

    case 0x82: {
      const value = param === 0x22 ? simBoard.firmware : board;
      const payload = [0x82, board, 0x00, value];
      return formatHex([...payload, bcc(payload)]);
    }

    case 0x7e:
      return buildAckFrame(0x7e, board, channel, param);

    default:
      return buildAckFrame(command, board, channel, 0x01);
  }
}

function sendFrameNow(bytes, timeoutMs = 900) {
  const hexString = formatHex(bytes);

  return new Promise((resolve) => {
    const id = ++responseId;

    const timer = setTimeout(() => {
      responseCallbacks.delete(id);
      resolve({ ok: false, error: 'TIMEOUT', hex: hexString });
    }, timeoutMs);

    if (isNative()) {
      responseCallbacks.set(id, (result) => {
        if (result.ok) {
          const parsed = parseResponse(result.hex);
          if (!responseMatchesRequest(parsed, bytes)) {
            return false;
          }
        }
        clearTimeout(timer);
        resolve(result);
        return true;
      });
      window.Android.sendRS485(hexString);
      return;
    }

    clearTimeout(timer);
    setTimeout(() => {
      const response = simulateResponse(bytes);
      resolve({ ok: true, hex: response, simulated: true });
    }, 140 + Math.random() * 120);
  });
}

export function sendFrame(bytes, timeoutMs = 900) {
  const run = () => sendFrameNow(bytes, timeoutMs);
  const request = sendQueue.then(run, run);
  sendQueue = request.catch(() => undefined);
  return request;
}

export const Serial = {
  actuate: (
    board,
    channel,
    actionModeId = DEFAULT_ACTION_MODE,
    profileId = DEFAULT_PROTOCOL
  ) => sendFrame(createActuationFrame(board, channel, actionModeId, profileId)),
  unlock: (board, channel, profileId = DEFAULT_PROTOCOL) =>
    sendFrame(createCommandSet(profileId).unlock(board, channel)),
  readStatus: (board, channel, profileId = DEFAULT_PROTOCOL) =>
    sendFrame(createCommandSet(profileId).readStatus(board, channel)),
  readAll: (board, profileId = DEFAULT_PROTOCOL) =>
    sendFrame(createCommandSet(profileId).readAll(board)),
  close: (board, channel, profileId = DEFAULT_PROTOCOL) =>
    sendFrame(createCommandSet(profileId).close(board, channel)),
  normallyOpen: (board, channel, profileId = DEFAULT_PROTOCOL) =>
    sendFrame(createCommandSet(profileId).normallyOpen(board, channel)),
  openAll: (board, profileId = DEFAULT_PROTOCOL) =>
    sendFrame(createCommandSet(profileId).openAll(board)),
  feedback: (board, enabled, profileId = DEFAULT_PROTOCOL) =>
    sendFrame(createCommandSet(profileId).setFeedback(board, enabled)),
  firmware: (board, profileId = DEFAULT_PROTOCOL) =>
    sendFrame(createCommandSet(profileId).queryFW(board)),
  uid: (board, profileId = DEFAULT_PROTOCOL) =>
    sendFrame(createCommandSet(profileId).queryUID(board)),
  setTimeout: (board, channel, seconds, profileId = DEFAULT_PROTOCOL) =>
    sendFrame(createCommandSet(profileId).setTimeout(board, channel, seconds)),
  getHardwareInfo: () => {
    const bridge = getAndroidBridge();

    if (!bridge) {
      const simBoard = getSimBoard(1);
      return {
        bridgeVersion: 'SIMULATED-BRIDGE',
        serialOpen: true,
        serialPath: '/dev/ttyS5',
        serialError: 'SIMULATED',
        zysjAvailable: true,
        zysjError: 'SIMULATED',
        zysjMcuVersion: simBoard.mcuVersion,
        zysjOutputChannel: simBoard.outputChannel,
        zysjGpio: { ...simBoard.gpio },
      };
    }

    return {
      bridgeVersion:
        typeof bridge.getBridgeVersion === 'function'
          ? bridge.getBridgeVersion()
          : 'UNKNOWN-BRIDGE',
      serialOpen:
        typeof bridge.isSerialOpen === 'function' ? bridge.isSerialOpen() : false,
      serialPath:
        typeof bridge.getSerialPath === 'function' ? bridge.getSerialPath() : '',
      serialError:
        typeof bridge.getLastSerialError === 'function'
          ? bridge.getLastSerialError()
          : 'N/A',
      zysjAvailable: false,
      zysjError: ZYSJ_SAFE_MODE ? 'ZYSJ_DISABLED_SAFE_MODE' : 'N/A',
      zysjMcuVersion: null,
      zysjOutputChannel: null,
      zysjGpio: {},
    };
  },
  getZysjSnapshot: () => {
    const bridge = getAndroidBridge();

    if (!bridge) {
      const simBoard = getSimBoard(1);
      return Promise.resolve({
        ok: true,
        gpio: { ...simBoard.gpio },
        outputChannel: simBoard.outputChannel,
        mcuVersion: simBoard.mcuVersion,
        simulated: true,
      });
    }

    if (ZYSJ_SAFE_MODE) {
      return Promise.resolve({
        ok: false,
        error: 'ZYSJ_DISABLED_SAFE_MODE',
      });
    }

    if (
      typeof bridge.isZysjAvailable !== 'function' ||
      !bridge.isZysjAvailable() ||
      typeof bridge.getZysjGpioSnapshot !== 'function'
    ) {
      return Promise.resolve({
        ok: false,
        error:
          typeof bridge.getLastZysjError === 'function'
            ? bridge.getLastZysjError()
            : 'ZYSJ_UNAVAILABLE',
      });
    }

    return Promise.resolve({
      ok: true,
      gpio: parseGpioSnapshot(bridge.getZysjGpioSnapshot()),
      outputChannel:
        typeof bridge.getZysjOutputChannel === 'function'
          ? normalizeOptionalNativeInt(bridge.getZysjOutputChannel())
          : null,
      mcuVersion:
        typeof bridge.getZysjMcuVersion === 'function'
          ? normalizeOptionalNativeInt(bridge.getZysjMcuVersion())
          : null,
    });
  },
  setZysjGpio: (pin, value) => {
    const bridge = getAndroidBridge();

    if (!bridge) {
      const simBoard = getSimBoard(1);
      simBoard.gpio[pin] = value ? 1 : 0;
      return Promise.resolve({ ok: true, pin, value: simBoard.gpio[pin], simulated: true });
    }

    if (typeof bridge.setZysjGpioValue !== 'function') {
      return Promise.resolve({ ok: false, error: 'ZYSJ_WRITE_UNAVAILABLE' });
    }

    const result = bridge.setZysjGpioValue(pin, value ? 1 : 0);
    return Promise.resolve({
      ok: result !== -2147483648,
      pin,
      value: value ? 1 : 0,
      result,
      error:
        result === -2147483648 && typeof bridge.getLastZysjError === 'function'
          ? bridge.getLastZysjError()
          : null,
    });
  },
  pulseZysjGpio: (pin, holdMs = 250) => {
    const bridge = getAndroidBridge();

    if (!bridge) {
      const simBoard = getSimBoard(1);
      simBoard.gpio[pin] = 1;
      simBoard.gpio[pin] = 0;
      return Promise.resolve({ ok: true, pin, value: 0, simulated: true });
    }

    if (typeof bridge.pulseZysjGpio !== 'function') {
      return Promise.resolve({ ok: false, error: 'ZYSJ_PULSE_UNAVAILABLE' });
    }

    const result = bridge.pulseZysjGpio(pin, holdMs);
    return Promise.resolve({
      ok: result !== -2147483648,
      pin,
      value: 0,
      result,
      error:
        result === -2147483648 && typeof bridge.getLastZysjError === 'function'
          ? bridge.getLastZysjError()
          : null,
    });
  },
  setZysjOutputChannel: (channel) => {
    const bridge = getAndroidBridge();

    if (!bridge) {
      const simBoard = getSimBoard(1);
      simBoard.outputChannel = channel;
      return Promise.resolve({ ok: true, channel, simulated: true });
    }

    if (typeof bridge.setZysjOutputChannel !== 'function') {
      return Promise.resolve({ ok: false, error: 'ZYSJ_OUTPUT_UNAVAILABLE' });
    }

    const ok = bridge.setZysjOutputChannel(channel);
    return Promise.resolve({
      ok,
      channel,
      error:
        !ok && typeof bridge.getLastZysjError === 'function'
          ? bridge.getLastZysjError()
          : null,
    });
  },
  isNative,
};

export default Serial;
