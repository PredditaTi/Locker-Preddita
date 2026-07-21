import React, { startTransition, useDeferredValue, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import edgeAgent, {
  SENSOR_POLARITY_OPTIONS,
  createCommandSet,
  decodePackedStates,
  formatHex,
  parseResponse,
} from './edgeAgent.js';
import {
  PACKAGE_SIZES,
  applyDeviceCommissioning,
  buildNotificationPreview,
  cancelDelivery,
  completePickup,
  confirmDeposit,
  countActiveDeliveries,
  createDoorCatalog,
  deliveryCanBeCollected,
  eraseDeliveryCredentials,
  findAvailableDoor,
  formatRecipientApartment,
  getDeliveryStatusLabel,
  getDoorOccupancyMap,
  markDeliveryNotification,
  markDepositDoorOpened,
  markPickupDoorOpened,
  reserveDelivery,
  resolvePickupRequest,
  updateDeviceConfig,
} from './lockerWorkflow.js';
import {
  createDoorCloseProof,
  createDoorOpenCycle,
  validateDirectDoorReading,
} from './doorSafety.js';
import {
  AuditCard,
  DeliveryCard,
  DoorCard,
  Pill,
  RecipientCard,
  StatCard,
  formatDateTime,
  joinClasses,
  trimCode,
} from './appUi.jsx';
import { resolveScannedPickupCredential, scanQrFromVideo } from './qrScanner.js';
import {
  applyBackspaceKey,
  applyDigitKey,
  getCourierSuccessPresentation,
  getPickupEntryPresentation,
  isCompletePin,
  shouldShowCourierPickupCredential,
} from './touchFlow.js';
import {
  CourierApartmentStep,
  CourierConfirmStep,
  CourierDoorStep,
  CourierSuccessStep,
  KioskNoticeDialog,
  PublicHome,
  ResidentPickupStep,
} from './publicKioskUi.jsx';
import {
  buildDeliveryCollectedEventId,
  buildDeliveryStoredEventId,
} from './deviceEventQueue.js';
import DiagnosticsView from './DiagnosticsView.jsx';
import useDiagnosticGate from './useDiagnosticGate.js';

const LOCKER_PROFILE = 'manual2025';
const COMMANDS = createCommandSet(LOCKER_PROFILE);
const DOORS_PER_PAGE = 8;
const DOOR_COUNT_PRESETS = [8, 12, 16, 20, 24];
const ADMIN_VIEWS = new Set(['admin', 'adminDeposit', 'adminPickup', 'doors', 'system']);
const APP_VERSION = '2.0.25-lab';
const POPUP_BANNER_TITLES = new Set([
  'Porta pequena ainda aberta',
  'Sem porta grande disponivel',
  'Portas grandes ocupadas',
]);
const COURIER_SUCCESS_RETURN_MS = 10000;
const DOOR_COMPLETION_CLOSE_TIMEOUT_MS = 45000;
const SMALL_DOOR_CLOSE_TIMEOUT_MS = 60000;
const SMALL_DOOR_CLOSE_POLL_MS = 1000;
const LABEL_PHOTO_MAX_WIDTH = 640;
const LABEL_PHOTO_JPEG_QUALITY = 0.62;
const PUBLIC_READY_BANNER = {
  tone: 'success',
  title: 'Locker operacional',
  text: 'Fluxos locais prontos para deposito, retirada e leitura das portas.',
};
const PICKUP_METHODS = [
  { id: 'pin', title: 'PIN', hint: 'Codigo de 6 digitos enviado ao apartamento.' },
  { id: 'predditaQr', title: 'QR PREDDITA', hint: 'Payload preddita://collect gerado no deposito.' },
  { id: 'externalQr', title: 'QR externo', hint: 'Codigo de terceiro ja vinculado a esta entrega.' },
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDeliveryNotificationText(delivery) {
  if (!delivery?.recipientEmail) {
    return 'Apartamento sem e-mail cadastrado. Use o PIN ou QR exibido para entregar o codigo manualmente.';
  }

  if (delivery.notificationStatus === 'sent') {
    return `E-mail enviado para ${delivery.recipientEmail}.`;
  }

  if (delivery.notificationStatus === 'pending') {
    return `Enviando PIN e QR para ${delivery.recipientEmail}...`;
  }

  if (delivery.notificationStatus === 'failed') {
    return `Nao foi possivel enviar para ${delivery.recipientEmail}: ${delivery.notificationError || 'verifique o servidor de e-mail.'}`;
  }

  if (delivery.notificationStatus === 'skipped') {
    return delivery.notificationError || 'Envio de e-mail nao realizado.';
  }

  return `PIN e QR prontos para envio para ${delivery.recipientEmail}.`;
}

function getDeliveryUnitLabel(delivery) {
  return delivery?.unit || delivery?.recipientName || 'Unidade nao informada';
}

function extractApartmentLabel(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/(?:ap(?:artamento)?\.?\s*)?(\d{1,6}[a-z]?)/i);
  return match ? match[1] : '';
}

function createDoorStates(doorCount) {
  return Array.from({ length: doorCount }, (_, index) => ({
    channel: index + 1,
    status: 'unknown',
    detail: 'Aguardando leitura da placa.',
    source: 'none',
    stateByte: null,
    statusKnown: false,
    validChecksum: false,
    ambiguous: true,
    sensorPolarity: '',
    readAt: '',
  }));
}

function normalizeDoorStates(previous, nextDoorCount) {
  const map = previous.reduce((accumulator, door) => {
    accumulator[door.channel] = door;
    return accumulator;
  }, {});

  return Array.from({ length: nextDoorCount }, (_, index) => {
    const channel = index + 1;
    return map[channel] ?? {
      channel,
      status: 'unknown',
      detail: 'Aguardando leitura da placa.',
      source: 'none',
      stateByte: null,
      statusKnown: false,
      validChecksum: false,
      ambiguous: true,
      sensorPolarity: '',
      readAt: '',
    };
  });
}

function mergeReadAll(previous, parsed, doorCount, alignment = 'right', sensorPolarity = 'zeroOpen') {
  if (!parsed || parsed.type !== 'all') {
    return normalizeDoorStates(previous, doorCount);
  }

  const decodedStates = Array.isArray(parsed.stateBytes)
    ? decodePackedStates(parsed.stateBytes, {
        channelCount: doorCount,
        alignment,
      })
    : parsed.states;

  const nextMap = decodedStates.reduce((accumulator, item) => {
    accumulator[item.channel] = {
      channel: item.channel,
      status: item.state ?? 'unknown',
      detail: item.detail ?? 'Sem detalhe adicional.',
      source: 'packed',
      stateByte: null,
      statusKnown: Boolean(item.state),
      validChecksum: Boolean(parsed.validChecksum),
      ambiguous: Boolean(item.ambiguous),
      sensorPolarity,
      readAt: new Date().toISOString(),
    };
    return accumulator;
  }, {});

  return Array.from({ length: doorCount }, (_, index) => {
    const channel = index + 1;
    return nextMap[channel] ?? {
      channel,
      status: 'unknown',
      detail: 'Canal fora do retorno da leitura em bloco.',
      source: 'none',
      stateByte: null,
      statusKnown: false,
      validChecksum: false,
      ambiguous: true,
      sensorPolarity,
      readAt: '',
    };
  });
}

function markDoorStatesUnknown(previous, doorCount, detail = 'Sem resposta recente da placa.') {
  return normalizeDoorStates(previous, doorCount).map((door) => ({
    ...door,
    status: 'unknown',
    detail,
    source: 'none',
    stateByte: null,
    statusKnown: false,
    validChecksum: false,
    ambiguous: true,
    readAt: '',
  }));
}

function getDoorState(doorStates, channel) {
  return (
    doorStates.find((door) => door.channel === channel) ?? {
      channel,
      status: 'unknown',
      detail: 'Sem leitura registrada.',
      source: 'none',
      stateByte: null,
      statusKnown: false,
      validChecksum: false,
      ambiguous: true,
      sensorPolarity: '',
      readAt: '',
    }
  );
}

function createSingleDoorReading(parsed, readAt = new Date().toISOString()) {
  if (parsed?.type !== 'single') {
    return null;
  }

  return {
    channel: parsed.channel,
    status: parsed.state ?? 'unknown',
    detail: parsed.detail ?? 'Sem detalhe adicional.',
    source: 'single',
    stateByte: Number.isInteger(parsed.stateByte) ? parsed.stateByte : null,
    statusKnown: Boolean(parsed.statusKnown),
    validChecksum: Boolean(parsed.validChecksum),
    ambiguous: Boolean(parsed.ambiguous),
    sensorPolarity: parsed.sensorPolarity ?? '',
    readAt,
  };
}

function createUnknownDoorReading(channel, sensorPolarity, detail) {
  return {
    channel,
    status: 'unknown',
    detail,
    source: 'none',
    stateByte: null,
    statusKnown: false,
    validChecksum: false,
    ambiguous: true,
    sensorPolarity,
    readAt: '',
  };
}

function filterDoorCatalogByPhysicalAvailability(catalog, doorStates) {
  return catalog.filter((door) => {
    const reading = getDoorState(doorStates, door.channel);
    return validateDirectDoorReading(reading, 'closed', { channel: door.channel }).ok;
  });
}

function buildDoorPresentation(door, physicalState, delivery) {
  return {
    ...door,
    delivery,
    physicalState,
    occupancyLabel: delivery ? getDeliveryStatusLabel(delivery) : 'Livre',
    physicalLabel:
      physicalState.status === 'open'
        ? 'Sensor indica aberta'
        : physicalState.status === 'closed'
        ? 'Sensor indica fechada'
        : 'Sem leitura recente',
  };
}

export default function App() {
  const initialStateRef = useRef(null);
  const [lockerState, setLockerState] = useState(() => {
    const loadedState = edgeAgent.loadLockerState();
    initialStateRef.current = loadedState;
    return loadedState;
  });
  const initialState = initialStateRef.current ?? lockerState;
  const [view, setView] = useState('home');
  const [banner, setBanner] = useState(PUBLIC_READY_BANNER);
  const [dismissedBannerKey, setDismissedBannerKey] = useState('');
  const [hardwareInfo, setHardwareInfo] = useState(() => edgeAgent.getHardwareInfo());
  const [doorStates, setDoorStates] = useState(() => createDoorStates(initialState.deviceConfig.doorCount));
  const [isBusy, setIsBusy] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastPreview, setLastPreview] = useState('');
  const [lastSyncAt, setLastSyncAt] = useState('');
  const [pickupMode, setPickupMode] = useState('pin');
  const [pickupValue, setPickupValue] = useState('');
  const [qrScannerState, setQrScannerState] = useState({ active: false, status: 'idle', error: '' });
  const [labelCapture, setLabelCapture] = useState({
    active: false,
    status: 'idle',
    photoDataUrl: '',
    capturedAt: '',
    error: '',
  });
  const [activeDepositId, setActiveDepositId] = useState('');
  const [activePickupId, setActivePickupId] = useState('');
  const [generatedDelivery, setGeneratedDelivery] = useState(null);
  const [courierSuccessDelivery, setCourierSuccessDelivery] = useState(null);
  const [pickupSuccessDelivery, setPickupSuccessDelivery] = useState(null);
  const [qrImage, setQrImage] = useState('');
  const [courierStep, setCourierStep] = useState('recipient');
  const [courierDepositStage, setCourierDepositStage] = useState('small');
  const [smallCloseSecondsLeft, setSmallCloseSecondsLeft] = useState(0);
  const [doorPage, setDoorPage] = useState(0);
  const [deviceForm, setDeviceForm] = useState({
    board: String(initialState.deviceConfig.board),
    doorCount: String(initialState.deviceConfig.doorCount),
    sensorPolarity: initialState.deviceConfig.sensorPolarity,
  });
  const [deliveryForm, setDeliveryForm] = useState({
    courierName: 'Portaria principal',
    orderCode: '',
    packageSize: '',
    externalCode: '',
    notes: '',
  });
  const [recipientSearch, setRecipientSearch] = useState('');
  const [selectedRecipientId, setSelectedRecipientId] = useState('');
  const deferredRecipientSearch = useDeferredValue(recipientSearch);
  const lockerStateRef = useRef(initialState);
  const doorStatesRef = useRef(doorStates);
  const syncInFlightRef = useRef(false);
  const remoteCloseInFlightRef = useRef(false);
  const courierOpenInFlightRef = useRef(false);
  const smallCloseCancelRef = useRef(false);
  const courierCancelRequestedRef = useRef(false);
  const pickupAutoSubmitRef = useRef('');
  const qrVideoRef = useRef(null);
  const qrCanvasRef = useRef(null);
  const qrStreamRef = useRef(null);
  const qrScanFrameRef = useRef(0);
  const qrScanLockedRef = useRef(false);
  const labelVideoRef = useRef(null);
  const labelCanvasRef = useRef(null);
  const labelStreamRef = useRef(null);
  const remoteResidentsRevisionRef = useRef(initialState.remoteResidentsRevision || '');
  const packedAlignmentRef = useRef('auto');
  const remoteCycleRunnerRef = useRef(null);
  const remotePickupReconcileRef = useRef(null);
  const diagnosticGate = useDiagnosticGate();
  const bannerKey = `${banner.tone || ''}:${banner.title}:${banner.text}`;

  useEffect(() => {
    lockerStateRef.current = lockerState;
  }, [lockerState]);

  useEffect(() => {
    doorStatesRef.current = doorStates;
  }, [doorStates]);

  useEffect(() => {
    setDismissedBannerKey('');
  }, [bannerKey]);

  useEffect(() => {
    const deliveriesToReplay = lockerStateRef.current.deliveries.filter((delivery) =>
      delivery.status === 'stored' &&
      delivery.recipientEmail &&
      delivery.notificationStatus !== 'sent'
    );

    if (deliveriesToReplay.length === 0) return;

    deliveriesToReplay.forEach((delivery) => {
      queueDeviceEvent(
        'delivery-stored',
        { delivery, sendEmail: true },
        {
          id: buildDeliveryStoredEventId(delivery.id),
          occurredAt: delivery.depositedAt || delivery.notificationRequestedAt || delivery.createdAt,
        }
      );
    });
    void flushPendingDeviceEvents();
  }, []);

  useEffect(() => {
    setDeviceForm({
      board: String(lockerState.deviceConfig.board),
      doorCount: String(lockerState.deviceConfig.doorCount),
      sensorPolarity: lockerState.deviceConfig.sensorPolarity,
    });
    setDoorStates((previous) => normalizeDoorStates(previous, lockerState.deviceConfig.doorCount));
    packedAlignmentRef.current = 'auto';
  }, [
    lockerState.deviceConfig.board,
    lockerState.deviceConfig.doorCount,
    lockerState.deviceConfig.sensorPolarity,
  ]);

  function commitState(transformer) {
    startTransition(() => {
      setLockerState((current) => {
        const nextState = typeof transformer === 'function' ? transformer(current) : transformer;
        lockerStateRef.current = nextState;
        edgeAgent.persistLockerState(nextState);
        return nextState;
      });
    });
  }

  async function syncHardwareStatus(options = {}) {
    const { silent = false } = options;
    if (syncInFlightRef.current) {
      return false;
    }

    const board = lockerState.deviceConfig.board;
    syncInFlightRef.current = true;
    setIsSyncing(true);
    setLastPreview(formatHex(COMMANDS.readAll(board)));

    try {
      const result = await edgeAgent.readAll(board, LOCKER_PROFILE);
      const parsed = result.ok
        ? parseResponse(result.hex, {
            sensorPolarity: lockerStateRef.current.deviceConfig.sensorPolarity,
          })
        : null;
      setHardwareInfo(edgeAgent.getHardwareInfo());

      if (result.ok && parsed?.type === 'all') {
        let packedAlignment = packedAlignmentRef.current;
        if (packedAlignment === 'auto') {
          packedAlignment = await resolvePackedAlignment(parsed);
          packedAlignmentRef.current = packedAlignment;
        }

        setDoorStates((previous) =>
          mergeReadAll(
            previous,
            parsed,
            lockerState.deviceConfig.doorCount,
            packedAlignment,
            lockerState.deviceConfig.sensorPolarity
          )
        );
        setLastSyncAt(new Date().toISOString());
        if (!silent) {
          setBanner({
            tone: 'success',
            title: 'Mapa de portas atualizado',
            text: `Leitura concluida para o board ${board} com ${lockerState.deviceConfig.doorCount} portas.`,
          });
        }
        return true;
      }

      setDoorStates((previous) =>
        markDoorStatesUnknown(
          previous,
          lockerState.deviceConfig.doorCount,
          result.ok
            ? 'Leitura em formato inesperado. Aguarde nova resposta da placa.'
            : 'Sem resposta recente da placa.'
        )
      );

      if (!silent) {
        setBanner({
          tone: 'danger',
          title: 'Falha ao ler o locker',
          text: result.ok
            ? 'A placa respondeu em um formato inesperado para a leitura em bloco.'
            : `Nao foi possivel ler o status do board ${board}: ${result.error}`,
        });
      }
      return false;
    } finally {
      syncInFlightRef.current = false;
      setIsSyncing(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const runInitial = async () => {
      if (!cancelled) await syncHardwareStatus({ silent: true });
    };
    runInitial();
    const timer = setInterval(() => {
      if (!isBusy && !syncInFlightRef.current) syncHardwareStatus({ silent: true });
    }, 12000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    lockerState.deviceConfig.board,
    lockerState.deviceConfig.doorCount,
    lockerState.deviceConfig.sensorPolarity,
    isBusy,
  ]);

  const doorCatalog = createDoorCatalog(
    lockerState.deviceConfig.doorCount,
    lockerState.deviceConfig.doorSizes,
  );
  const availableDoorCatalog = filterDoorCatalogByPhysicalAvailability(doorCatalog, doorStates);
  const smallDoorCatalog = doorCatalog.filter((door) => door.size === 'P');
  const largeDoorCatalog = doorCatalog.filter((door) => door.size === 'G');
  const occupancyMap = getDoorOccupancyMap(lockerState.deliveries);
  const selectedRecipient = lockerState.recipients.find((recipient) => recipient.id === selectedRecipientId) ?? null;
  const filteredRecipients = lockerState.recipients.filter((recipient) => {
    const query = deferredRecipientSearch.trim().toLowerCase();
    if (!query) return true;
    return [recipient.apartment, recipient.unit, recipient.building, recipient.floor].join(' ').toLowerCase().includes(query);
  });
  const activeDeliveries = lockerState.deliveries.filter((delivery) => ['door_opened_for_dropoff', 'stored', 'pickup_opened'].includes(delivery.status));
  const collectibleDeliveries = activeDeliveries.filter((delivery) => deliveryCanBeCollected(delivery));
  const pickupMethodsForView =
    view === 'resident'
      ? PICKUP_METHODS.filter((method) => method.id !== 'externalQr')
      : PICKUP_METHODS;
  const freeDoorCount = doorCatalog.length - Object.keys(occupancyMap).length;
  const openDoorCount = doorStates.filter((door) => door.status === 'open').length;
  const hasSelectedPackageSize = ['P', 'M', 'G'].includes(deliveryForm.packageSize);
  const recommendedDoor =
    view === 'courier' && !hasSelectedPackageSize
      ? null
      : findAvailableDoor(lockerState, hasSelectedPackageSize ? deliveryForm.packageSize : 'M', availableDoorCatalog);
  const activeDeposit = lockerState.deliveries.find((delivery) => delivery.id === activeDepositId) ?? null;
  const activePickup = lockerState.deliveries.find((delivery) => delivery.id === activePickupId) ?? null;
  const credentialDelivery = activeDeposit ?? generatedDelivery ?? courierSuccessDelivery;
  const isPickupCodeReady = pickupMode === 'pin' ? isCompletePin(pickupValue) : pickupValue.trim().length > 0;
  const courierSuccessPresentation = courierSuccessDelivery
    ? getCourierSuccessPresentation(courierSuccessDelivery)
    : null;
  const pickupEntryPresentation = getPickupEntryPresentation(pickupMode, pickupValue);
  const isAdminView = ADMIN_VIEWS.has(view);
  const isHomeView = view === 'home';
  const isPublicFlowView = view === 'courier' || view === 'resident';
  const isPublicEmailBanner = isPublicFlowView && banner.title.toLowerCase().includes('e-mail');
  const publicPageTitle = view === 'courier' ? 'Entregador' : 'Buscar entrega';
  const publicPageText =
    view === 'courier'
      ? 'Depositar encomenda e gerar codigo de retirada.'
      : 'Inserir codigo ou QR para abrir a porta.';
  const showBanner =
    !isHomeView &&
    !isPublicEmailBanner &&
    (!isPublicFlowView || banner.title !== 'Locker operacional' || banner.tone !== 'success');
  const isPopupBanner =
    isPublicFlowView &&
    (banner.tone === 'danger' || banner.tone === 'warn' || POPUP_BANNER_TITLES.has(banner.title));
  const showBannerPopup =
    showBanner &&
    isPopupBanner &&
    dismissedBannerKey !== bannerKey;
  const showInlineBanner = showBanner && !isPopupBanner && !isPublicFlowView;
  const doorCards = doorCatalog.map((door) => buildDoorPresentation(door, getDoorState(doorStates, door.channel), occupancyMap[door.channel] ?? null));
  const doorPageCount = Math.max(1, Math.ceil(doorCards.length / DOORS_PER_PAGE));
  const visibleDoorCards = doorCards.slice(
    doorPage * DOORS_PER_PAGE,
    doorPage * DOORS_PER_PAGE + DOORS_PER_PAGE
  );
  const homeDoorPreview = doorCards.slice(0, 4);
  const recentAudit = lockerState.auditTrail.slice(0, 4);
  const systemAudit = lockerState.auditTrail.slice(0, 8);
  const occupiedDoorCount = countActiveDeliveries(lockerState.deliveries);
  const doorPageStart = doorPage * DOORS_PER_PAGE + 1;
  const doorPageEnd = Math.min(doorCards.length, doorPageStart + visibleDoorCards.length - 1);

  useEffect(() => {
    setDoorPage((previous) => Math.min(previous, doorPageCount - 1));
  }, [doorPageCount]);

  useEffect(() => {
    if (view === 'resident' && pickupMode === 'externalQr') {
      setPickupMode('pin');
      setPickupValue('');
    }
  }, [pickupMode, view]);

  useEffect(() => {
    if (view !== 'resident' || pickupMode !== 'pin' || activePickup || isBusy) {
      return;
    }

    if (!isCompletePin(pickupValue)) {
      pickupAutoSubmitRef.current = '';
      return;
    }

    if (pickupAutoSubmitRef.current === pickupValue) {
      return;
    }

    pickupAutoSubmitRef.current = pickupValue;
    void validatePickupCredential('pin', pickupValue);
  }, [activePickup, isBusy, pickupMode, pickupValue, view]);

  useEffect(() => {
    if (view !== 'resident') {
      stopQrScanner();
    }
  }, [view]);

  useEffect(() => () => {
    stopQrScanner({ updateState: false });
  }, []);

  useEffect(() => {
    if (activeDepositId) {
      resetLabelCapture();
      return;
    }

    stopLabelCamera({ updateState: false });
  }, [activeDepositId]);

  useEffect(() => () => {
    stopLabelCamera({ updateState: false });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const payload = credentialDelivery?.qrPayload ?? '';

    if (!payload) {
      setQrImage('');
      return () => {
        cancelled = true;
      };
    }

    QRCode.toDataURL(payload, {
      margin: 2,
      width: 256,
      color: {
        dark: '#01233f',
        light: '#ffffff',
      },
    })
      .then((dataUrl) => {
        if (!cancelled) setQrImage(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrImage('');
      });

    return () => {
      cancelled = true;
    };
  }, [credentialDelivery?.qrPayload]);

  function queueDeviceEvent(type, payload = {}, options = {}) {
    return edgeAgent.queueEvent(type, payload, options);
  }

  function queueDoorOpenedEvent(channel, outcome, successText) {
    queueDeviceEvent('door-opened', {
      door: channel,
      board: lockerStateRef.current.deviceConfig.board,
      confirmed: Boolean(outcome.confirmed),
      reason: outcome.reason || '',
      status: outcome.ok ? 'opened' : 'failed',
      message: successText,
      physicalCycle: outcome.cycle ?? null,
    });
  }

  async function actuateDoor(channel, successText, operation) {
    const board = lockerStateRef.current.deviceConfig.board;
    setIsBusy(true);
    setLastPreview(formatHex(COMMANDS.unlock(board, channel)));

    try {
      const rememberOpened = (outcome) => {
        queueDoorOpenedEvent(channel, outcome, successText);
        return outcome;
      };
      const baselineReading = await readDoorPhysicalStatus(channel);
      const baseline = validateDirectDoorReading(baselineReading, 'closed', { channel });
      if (!baseline.ok) {
        const outcome = {
          ok: false,
          confirmed: false,
          reason: `unsafe-precondition:${baseline.reason}`,
          error: 'A porta precisa estar fechada e responder ao sensor antes da abertura.',
        };
        setBanner({
          tone: 'danger',
          title: `Porta ${channel} indisponivel`,
          text: 'A leitura individual nao confirmou que a porta esta fechada. Verifique o sensor e tente novamente.',
        });
        return rememberOpened(outcome);
      }

      const timeoutResult = await edgeAgent.setTimeout(
        board,
        channel,
        lockerStateRef.current.deviceConfig.unlockTimeoutSeconds,
        LOCKER_PROFILE,
      );
      if (!timeoutResult.ok) {
        const outcome = {
          ok: false,
          confirmed: false,
          reason: `unlock-timeout-config:${String(timeoutResult.error || 'error').toLowerCase()}`,
          error: 'A placa nao confirmou o tempo de acionamento configurado.',
        };
        setBanner({
          tone: 'danger',
          title: `Porta ${channel} indisponivel`,
          text: 'O tempo de acionamento nao foi aceito pela placa. Rode o comissionamento antes de tentar novamente.',
        });
        return rememberOpened(outcome);
      }

      const result = await edgeAgent.unlock(board, channel, LOCKER_PROFILE);
      let cycleResult = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await wait(attempt === 0 ? 450 : 350);
        const openReading = await readDoorPhysicalStatus(channel);
        cycleResult = createDoorOpenCycle(baseline.reading, openReading, operation);
        if (cycleResult.ok) break;
      }

      if (!cycleResult?.ok) {
        const outcome = {
          ok: false,
          confirmed: false,
          reason: result.ok
            ? `open-not-confirmed:${cycleResult?.reason || 'no-reading'}`
            : `unlock-${String(result.error || 'error').toLowerCase()}:${cycleResult?.reason || 'no-reading'}`,
          error: result.ok
            ? 'O sensor nao confirmou a transicao de fechada para aberta.'
            : `O comando retornou ${result.error} e o sensor nao confirmou a abertura.`,
        };
        setBanner({
          tone: 'danger',
          title: `Abertura da porta ${channel} nao confirmada`,
          text: 'O fluxo foi interrompido porque o sensor nao confirmou a abertura. Verifique a porta antes de tentar novamente.',
        });
        return rememberOpened(outcome);
      }

      const outcome = {
        ok: true,
        confirmed: true,
        reason: 'physical-cycle-opened',
        cycle: cycleResult.cycle,
      };
      setBanner({ tone: 'success', title: `Porta ${channel} acionada`, text: successText });
      return rememberOpened(outcome);
    } finally {
      setIsBusy(false);
    }
  }

  async function readDoorPhysicalStatus(channel) {
    const board = lockerStateRef.current.deviceConfig.board;
    const sensorPolarity = lockerStateRef.current.deviceConfig.sensorPolarity;
    const result = await edgeAgent.readStatus(board, channel, LOCKER_PROFILE);
    const parsed = result.ok ? parseResponse(result.hex, { sensorPolarity }) : null;
    const reading = createSingleDoorReading(parsed);

    if (reading && parsed.board === board && parsed.channel === channel) {
      setDoorStates((previous) => {
        const nextStates = previous.map((door) =>
          door.channel === channel ? reading : door
        );
        doorStatesRef.current = nextStates;
        return nextStates;
      });
      return reading;
    }

    const unknown = createUnknownDoorReading(
      channel,
      sensorPolarity,
      result.ok ? 'Resposta individual invalida da placa.' : `Sem resposta individual: ${result.error}`
    );
    setDoorStates((previous) => {
      const nextStates = previous.map((door) => door.channel === channel ? unknown : door);
      doorStatesRef.current = nextStates;
      return nextStates;
    });
    return unknown;
  }

  async function waitForDoorClosed(channel, cycle, options = {}) {
    const timeoutMs =
      typeof options === 'number' ? options : options.timeoutMs ?? SMALL_DOOR_CLOSE_TIMEOUT_MS;
    const onTick = typeof options === 'object' && typeof options.onTick === 'function' ? options.onTick : null;
    const isCancelled =
      typeof options === 'object' && typeof options.isCancelled === 'function' ? options.isCancelled : null;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (isCancelled?.()) {
        return { status: 'cancelled', proof: null };
      }
      const reading = await readDoorPhysicalStatus(channel);
      const closeResult = createDoorCloseProof(cycle, reading);
      if (closeResult.ok) {
        onTick?.(0);
        return { status: 'closed', proof: closeResult.proof };
      }
      onTick?.(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
      await wait(SMALL_DOOR_CLOSE_POLL_MS);
    }

    return { status: isCancelled?.() ? 'cancelled' : 'timeout', proof: null };
  }

  async function waitForCompletionDoorClosed(channel, cycle, messages = {}) {
    setBanner({
      tone: 'success',
      title: messages.waitingTitle || 'Feche a porta',
      text: messages.waitingText || `Feche a porta ${channel} para concluir a operacao com seguranca.`,
    });

    const finalResult = await waitForDoorClosed(channel, cycle, {
      timeoutMs: messages.timeoutMs ?? DOOR_COMPLETION_CLOSE_TIMEOUT_MS,
    });

    if (finalResult.status === 'closed') {
      return finalResult.proof;
    }

    setBanner({
      tone: 'warn',
      title: messages.timeoutTitle || 'Porta ainda aberta',
      text: messages.timeoutText || `A porta ${channel} ainda nao apareceu como fechada. Feche a porta e toque novamente para concluir.`,
    });
    return null;
  }

  async function findPhysicallySafeAvailableDoor(state, packageSize, catalog) {
    let remainingCatalog = [...catalog];

    while (remainingCatalog.length > 0) {
      const candidate = findAvailableDoor(state, packageSize, remainingCatalog);
      if (!candidate) return null;

      const reading = await readDoorPhysicalStatus(candidate.channel);
      if (validateDirectDoorReading(reading, 'closed', { channel: candidate.channel }).ok) {
        return candidate;
      }

      remainingCatalog = remainingCatalog.filter((door) => door.channel !== candidate.channel);
    }

    return null;
  }

  async function resolvePackedAlignment(parsed) {
    if (!Array.isArray(parsed?.stateBytes) || parsed.stateBytes.length === 0) {
      return 'right';
    }

    const board = lockerState.deviceConfig.board;
    const doorCount = lockerState.deviceConfig.doorCount;
    const rightStates = decodePackedStates(parsed.stateBytes, {
      channelCount: doorCount,
      alignment: 'right',
    });
    const leftStates = decodePackedStates(parsed.stateBytes, {
      channelCount: doorCount,
      alignment: 'left',
    });

    const channelsToProbe = Math.min(3, doorCount);
    for (let channel = 1; channel <= channelsToProbe; channel += 1) {
      const probeResult = await edgeAgent.readStatus(board, channel, LOCKER_PROFILE);
      const probeParsed = probeResult.ok
        ? parseResponse(probeResult.hex, {
            sensorPolarity: lockerStateRef.current.deviceConfig.sensorPolarity,
          })
        : null;
      if (probeParsed?.type !== 'single') {
        continue;
      }

      const probeState = probeParsed.state ?? 'unknown';
      const rightState = rightStates[channel - 1]?.state ?? 'unknown';
      const leftState = leftStates[channel - 1]?.state ?? 'unknown';

      if (probeState === leftState && probeState !== rightState) {
        return 'left';
      }

      if (probeState === rightState && probeState !== leftState) {
        return 'right';
      }
    }

    const rightOpenCount = rightStates.filter((door) => door.state === 'open').length;
    const leftOpenCount = leftStates.filter((door) => door.state === 'open').length;

    if (rightOpenCount === doorCount && leftOpenCount < rightOpenCount) {
      return 'left';
    }

    if (leftOpenCount === doorCount && rightOpenCount < leftOpenCount) {
      return 'right';
    }

    return 'right';
  }

  async function handleCreateDeposit() {
    if (!selectedRecipient) {
      setBanner({ tone: 'danger', title: 'Apartamento obrigatorio', text: 'Selecione o apartamento antes de abrir um compartimento.' });
      return;
    }

    if (view === 'courier' && !hasSelectedPackageSize) {
      setBanner({ tone: 'danger', title: 'Volume obrigatorio', text: 'Escolha o tamanho do volume antes de abrir a porta.' });
      return;
    }

    try {
      const currentState = lockerStateRef.current;
      const safeDoor = await findPhysicallySafeAvailableDoor(
        currentState,
        deliveryForm.packageSize,
        doorCatalog
      );
      if (!safeDoor) {
        throw new Error('Nenhuma porta livre confirmou fechamento pelo sensor. Verifique o hardware.');
      }

      const { state: nextState, delivery } = await reserveDelivery(currentState, {
        recipientId: selectedRecipient.id,
        courierName: deliveryForm.courierName,
        orderCode: deliveryForm.orderCode,
        packageSize: deliveryForm.packageSize,
        externalCode: deliveryForm.externalCode,
        notes: deliveryForm.notes,
        doorCatalog: [safeDoor],
      });

      setGeneratedDelivery(null);
      commitState(nextState);
      setActiveDepositId(delivery.id);
      setView(view === 'adminDeposit' ? 'adminDeposit' : 'courier');

      const opened = await actuateDoor(
        delivery.door,
        `Compartimento pronto para o entregador armazenar a encomenda do ${getDeliveryUnitLabel(delivery)}.`,
        'dropoff'
      );

      if (!opened.ok) {
        commitState((current) => cancelDelivery(current, delivery.id, 'Falha tecnica ao abrir a porta.'));
        setActiveDepositId('');
        return;
      }

      commitState((current) => markDepositDoorOpened(current, delivery.id, opened.cycle));

      setDeliveryForm((current) => ({ ...current, orderCode: '', packageSize: '', externalCode: '', notes: '' }));
    } catch (error) {
      setBanner({ tone: 'danger', title: 'Deposito nao iniciado', text: error.message });
    }
  }

  async function openCourierSmallDoor(recipientId) {
    if (isBusy || courierOpenInFlightRef.current) return;

    courierOpenInFlightRef.current = true;
    smallCloseCancelRef.current = false;
    courierCancelRequestedRef.current = false;
    setGeneratedDelivery(null);
    setCourierSuccessDelivery(null);
    setCourierDepositStage('small');
    setBanner(PUBLIC_READY_BANNER);

    try {
      const currentState = lockerStateRef.current;
      const safeDoor = await findPhysicallySafeAvailableDoor(currentState, 'P', smallDoorCatalog);
      if (!safeDoor) {
        throw new Error('Nenhuma porta pequena confirmou fechamento pelo sensor.');
      }

      const { state: nextState, delivery } = await reserveDelivery(currentState, {
        recipientId,
        courierName: deliveryForm.courierName,
        orderCode: deliveryForm.orderCode,
        packageSize: 'P',
        externalCode: deliveryForm.externalCode,
        notes: deliveryForm.notes,
        doorCatalog: [safeDoor],
      });

      commitState(nextState);
      setActiveDepositId(delivery.id);
      setCourierStep('dropoff');
      setView('courier');

      const opened = await actuateDoor(
        delivery.door,
        `Porta pequena liberada para o ${getDeliveryUnitLabel(delivery)}.`,
        'dropoff'
      );

      if (!opened.ok) {
        commitState((current) => cancelDelivery(current, delivery.id, 'Falha tecnica ao abrir a porta pequena.'));
        setActiveDepositId('');
        resetCourierFlow();
        return;
      }

      commitState((current) => markDepositDoorOpened(current, delivery.id, opened.cycle));
    } catch (_error) {
      setActiveDepositId('');
      setCourierStep('recipient');
      setBanner({
        tone: 'warn',
        title: 'Sem porta pequena disponivel',
        text: 'Todas as portas pequenas estao ocupadas. Tente novamente em alguns instantes ou procure a administracao.',
      });
    } finally {
      courierOpenInFlightRef.current = false;
    }
  }

  async function handleUseLargeDoor() {
    if (!activeDeposit || isBusy) return;

    const previousDeposit = activeDeposit;
    const availableLargeDoor = findAvailableDoor(lockerStateRef.current, 'G', largeDoorCatalog);
    if (!availableLargeDoor) {
      setBanner({
        tone: 'warn',
        title: 'Portas grandes ocupadas',
        text: 'As portas grandes 1 e 2 estao ocupadas agora. Guarde a entrega na porta pequena aberta ou cancele a operacao para procurar a administracao.',
      });
      return;
    }

    smallCloseCancelRef.current = false;
    courierCancelRequestedRef.current = false;
    setCourierDepositStage('waiting-small-close');
    setSmallCloseSecondsLeft(Math.ceil(SMALL_DOOR_CLOSE_TIMEOUT_MS / 1000));
    setBanner({
      tone: 'success',
      title: 'Feche a porta pequena',
      text: `Feche a porta ${previousDeposit.door}. Assim que o sensor indicar fechada, uma porta grande sera aberta.`,
    });

    const closed = await waitForDoorClosed(
      previousDeposit.door,
      previousDeposit.dropoffDoorCycle,
      {
      timeoutMs: SMALL_DOOR_CLOSE_TIMEOUT_MS,
      onTick: setSmallCloseSecondsLeft,
      isCancelled: () => smallCloseCancelRef.current,
      }
    );
    if (closed.status === 'cancelled') {
      return;
    }
    if (closed.status !== 'closed') {
      const cancellationTimedOut = courierCancelRequestedRef.current;
      courierCancelRequestedRef.current = false;
      setCourierDepositStage('small');
      setSmallCloseSecondsLeft(0);
      setBanner({
        tone: 'warn',
        title: 'Porta pequena ainda aberta',
        text: cancellationTimedOut
          ? `O cancelamento nao foi concluido. A reserva continua ativa; feche a porta ${previousDeposit.door} antes de tentar novamente.`
          : `Feche a porta ${previousDeposit.door} para liberar uma porta grande.`,
      });
      return;
    }
    setSmallCloseSecondsLeft(0);

    if (courierCancelRequestedRef.current) {
      const stateAfterCancel = cancelDelivery(
        lockerStateRef.current,
        previousDeposit.id,
        'Troca para porta grande cancelada pelo entregador.'
      );
      commitState(stateAfterCancel);
      setActiveDepositId('');
      resetCourierFlow();
      setBanner({
        tone: 'warn',
        title: 'Operacao cancelada',
        text: `A porta ${previousDeposit.door} foi confirmada fechada e a reserva foi cancelada.`,
      });
      return;
    }

    const stateAfterSmallCancel = cancelDelivery(
      lockerStateRef.current,
      previousDeposit.id,
      'Entrega nao coube na porta pequena.'
    );

    try {
      const safeDoor = await findPhysicallySafeAvailableDoor(
        stateAfterSmallCancel,
        'G',
        largeDoorCatalog
      );
      if (!safeDoor) {
        throw new Error('Nenhuma porta grande confirmou fechamento pelo sensor.');
      }

      const { state: nextState, delivery } = await reserveDelivery(stateAfterSmallCancel, {
        recipientId: previousDeposit.recipientId,
        courierName: previousDeposit.courierName,
        orderCode: previousDeposit.orderCode,
        packageSize: 'G',
        externalCode: previousDeposit.externalCode,
        notes: previousDeposit.notes,
        doorCatalog: [safeDoor],
      });

      commitState(nextState);
      setActiveDepositId(delivery.id);
      setCourierDepositStage('large');

      const opened = await actuateDoor(
        delivery.door,
        `Porta grande liberada para o ${getDeliveryUnitLabel(delivery)}.`,
        'dropoff'
      );

      if (!opened.ok) {
        commitState((current) => cancelDelivery(current, delivery.id, 'Falha tecnica ao abrir a porta grande.'));
        setActiveDepositId('');
        resetCourierFlow();
        return;
      }

      commitState((current) => markDepositDoorOpened(current, delivery.id, opened.cycle));
    } catch (_error) {
      commitState(stateAfterSmallCancel);
      setActiveDepositId('');
      resetCourierFlow();
      setBanner({
        tone: 'warn',
        title: 'Sem porta grande disponivel',
        text: 'A porta pequena foi liberada, mas nao existe porta grande livre agora.',
      });
    }
  }

  async function handleConfirmDeposit() {
    if (!activeDeposit || isBusy) return;
    const deliveryToConfirm = activeDeposit;
    const isCourierDeposit = view === 'courier';
    const previousCourierStage = courierDepositStage;
    const completionStage = previousCourierStage === 'large' ? 'large-confirming' : 'small-confirming';

    setIsBusy(true);
    if (isCourierDeposit) {
      setCourierDepositStage(completionStage);
    }

    try {
      const closeProof = await waitForCompletionDoorClosed(
        deliveryToConfirm.door,
        deliveryToConfirm.dropoffDoorCycle,
        {
        waitingTitle: 'Feche a porta para concluir',
        waitingText: `Feche a porta ${deliveryToConfirm.door}. Assim que o sensor confirmar, o PIN e o QR serao gerados.`,
        timeoutTitle: 'Porta ainda aberta',
        timeoutText: `A porta ${deliveryToConfirm.door} ainda nao apareceu como fechada. Feche a porta e toque em Item guardado novamente.`,
        }
      );

      if (!closeProof) {
        if (isCourierDeposit) {
          setCourierDepositStage(previousCourierStage);
        }
        return;
      }

      const notificationRequestedAt = new Date().toISOString();
      const labelEvidence = buildLabelEvidencePayload(deliveryToConfirm);
      const confirmedDelivery = {
        ...deliveryToConfirm,
        status: 'stored',
        depositedAt: deliveryToConfirm.depositedAt || closeProof.closedAt,
        notificationStatus: deliveryToConfirm.recipientEmail ? 'pending' : 'skipped',
        notificationRequestedAt,
        notificationError: deliveryToConfirm.recipientEmail ? '' : 'Apartamento sem e-mail cadastrado.',
        dropoffCloseProof: closeProof,
        ...labelEvidence,
      };

      setGeneratedDelivery(confirmedDelivery);
      if (isCourierDeposit) {
        setCourierSuccessDelivery(confirmedDelivery);
        setCourierStep('success');
        setCourierDepositStage('success');
      }
      commitState((current) =>
        markDeliveryNotification(
          confirmDeposit(current, deliveryToConfirm.id, labelEvidence, closeProof),
          deliveryToConfirm.id,
          {
            status: confirmedDelivery.notificationStatus,
            requestedAt: confirmedDelivery.notificationRequestedAt,
            error: confirmedDelivery.notificationError,
          }
        )
      );
      setActiveDepositId('');
      resetLabelCapture();
      setDeliveryForm((current) => ({ ...current, orderCode: '', externalCode: '', notes: '', packageSize: '' }));
      if (isCourierDeposit) {
        setRecipientSearch('');
        setSelectedRecipientId('');
        setBanner({
          tone: 'success',
          title: 'Entrega registrada',
          text: deliveryToConfirm.recipientEmail
            ? `PIN ${deliveryToConfirm.pin} e QR PREDDITA gerados para ${getDeliveryUnitLabel(deliveryToConfirm)}. Voltando ao inicio automaticamente.`
            : `PIN ${deliveryToConfirm.pin} e QR PREDDITA gerados para ${getDeliveryUnitLabel(deliveryToConfirm)}. Apartamento sem e-mail cadastrado.`,
        });
      } else {
        resetCourierFlow();
        setBanner({
          tone: 'success',
          title: 'Encomenda armazenada',
          text: deliveryToConfirm.recipientEmail
            ? `Enviando PIN ${deliveryToConfirm.pin} e QR PREDDITA para ${deliveryToConfirm.recipientEmail}.`
            : `PIN ${deliveryToConfirm.pin} e QR PREDDITA prontos, mas o apartamento nao tem e-mail cadastrado.`,
        });
      }

      queueDeviceEvent('delivery-stored', {
        delivery: confirmedDelivery,
        sendEmail: Boolean(deliveryToConfirm.recipientEmail),
      }, {
        id: buildDeliveryStoredEventId(deliveryToConfirm.id),
        occurredAt: confirmedDelivery.depositedAt || confirmedDelivery.notificationRequestedAt,
      });
      void flushPendingDeviceEvents();
    } catch (error) {
      if (isCourierDeposit) {
        setCourierDepositStage(previousCourierStage);
      }
      setBanner({
        tone: 'danger',
        title: 'Nao foi possivel confirmar',
        text: error?.message || 'A leitura da porta falhou. Feche a porta e tente novamente.',
      });
    } finally {
      setIsBusy(false);
    }
  }

  function handleCancelDeposit() {
    if (!activeDeposit) return;
    setGeneratedDelivery(null);
    commitState((current) => cancelDelivery(current, activeDeposit.id, 'Reserva cancelada pelo operador.'));
    setActiveDepositId('');
    resetCourierFlow();
    setBanner({
      tone: 'warn',
      title: 'Reserva cancelada',
      text: `A porta ${activeDeposit.door} voltou a ficar disponivel para uma nova entrega.`,
    });
  }

  function handleCancelWaitingForLargeDoor() {
    if (!activeDeposit) return;
    courierCancelRequestedRef.current = true;
    setCourierDepositStage('cancelling-small-close');
    setBanner({
      tone: 'warn',
      title: 'Feche a porta para cancelar',
      text: `A reserva sera cancelada assim que o sensor confirmar a porta ${activeDeposit.door} fechada.`,
    });
  }

  function finishCourierSuccessNow() {
    setGeneratedDelivery(null);
    setCourierSuccessDelivery(null);
    resetCourierFlow();
    setView('home');
    setBanner(PUBLIC_READY_BANNER);
  }

  function stopQrScanner(options = {}) {
    const { updateState = true } = options;

    if (qrScanFrameRef.current) {
      window.cancelAnimationFrame(qrScanFrameRef.current);
      qrScanFrameRef.current = 0;
    }

    if (qrStreamRef.current) {
      qrStreamRef.current.getTracks().forEach((track) => track.stop());
      qrStreamRef.current = null;
    }

    if (qrVideoRef.current) {
      qrVideoRef.current.srcObject = null;
    }

    qrScanLockedRef.current = false;

    if (updateState) {
      setQrScannerState({ active: false, status: 'idle', error: '' });
    }
  }

  function stopLabelCamera(options = {}) {
    const { updateState = true } = options;

    if (labelStreamRef.current) {
      labelStreamRef.current.getTracks().forEach((track) => track.stop());
      labelStreamRef.current = null;
    }

    if (labelVideoRef.current) {
      labelVideoRef.current.srcObject = null;
    }

    if (updateState) {
      setLabelCapture((current) => ({
        ...current,
        active: false,
        status: current.photoDataUrl ? 'captured' : 'idle',
        error: '',
      }));
    }
  }

  function resetLabelCapture() {
    stopLabelCamera({ updateState: false });
    setLabelCapture({
      active: false,
      status: 'idle',
      photoDataUrl: '',
      capturedAt: '',
      error: '',
    });
  }

  async function startLabelCamera() {
    const mediaDevices = window.navigator?.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      setLabelCapture((current) => ({
        ...current,
        active: false,
        status: 'idle',
        error: 'Camera indisponivel neste navegador. Continue sem foto se necessario.',
      }));
      setBanner({
        tone: 'warn',
        title: 'Camera indisponivel',
        text: 'Nao foi possivel acessar a camera para fotografar a etiqueta. A entrega ainda pode ser registrada.',
      });
      return;
    }

    stopLabelCamera({ updateState: false });
    setLabelCapture({ active: true, status: 'opening', photoDataUrl: '', capturedAt: '', error: '' });

    try {
      const stream = await mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      labelStreamRef.current = stream;
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      const video = labelVideoRef.current;
      if (!video) {
        throw new Error('Preview da camera nao esta pronto.');
      }

      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      video.muted = true;
      await video.play();
      setLabelCapture({ active: true, status: 'ready', photoDataUrl: '', capturedAt: '', error: '' });
    } catch (_error) {
      stopLabelCamera({ updateState: false });
      setLabelCapture((current) => ({
        ...current,
        active: false,
        status: 'idle',
        error: 'Nao foi possivel abrir a camera. Confira a permissao e tente novamente.',
      }));
      setBanner({
        tone: 'warn',
        title: 'Camera nao abriu',
        text: 'Confira a permissao da camera. Se precisar, continue a entrega sem foto.',
      });
    }
  }

  function captureLabelPhoto() {
    const video = labelVideoRef.current;
    const canvas = labelCanvasRef.current;
    if (!video || !canvas) {
      setLabelCapture((current) => ({
        ...current,
        error: 'Preview da camera nao esta pronto para captura.',
      }));
      return;
    }

    const sourceWidth = video.videoWidth || 1280;
    const sourceHeight = video.videoHeight || 720;
    const scale = Math.min(1, LABEL_PHOTO_MAX_WIDTH / sourceWidth);
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      setLabelCapture((current) => ({
        ...current,
        error: 'Este navegador nao conseguiu processar a foto da etiqueta.',
      }));
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const capturedAt = new Date().toISOString();
    const photoDataUrl = canvas.toDataURL('image/jpeg', LABEL_PHOTO_JPEG_QUALITY);
    stopLabelCamera({ updateState: false });
    setLabelCapture({
      active: false,
      status: 'captured',
      photoDataUrl,
      capturedAt,
      error: '',
    });
    setBanner({
      tone: 'success',
      title: 'Etiqueta fotografada',
      text: 'Comprovante salvo localmente. Agora guarde a encomenda e toque em Item guardado.',
    });
  }

  function buildLabelEvidencePayload(delivery = activeDeposit) {
    const apartment = extractApartmentLabel(delivery?.unit) || extractApartmentLabel(delivery?.recipientName);
    return {
      labelPhotoDataUrl: labelCapture.photoDataUrl,
      labelPhotoCapturedAt: labelCapture.capturedAt,
      labelOcrStatus: labelCapture.photoDataUrl ? 'photo-captured' : 'not-captured',
      labelOcrApartment: apartment,
      labelOcrConfidence: labelCapture.photoDataUrl ? 1 : null,
      labelProofRequired: Boolean(labelCapture.photoDataUrl),
    };
  }

  async function validatePickupCredential(mode, rawValue) {
    if (isBusy) return;

    if (mode === 'pin' && !isCompletePin(rawValue)) {
      setBanner({ tone: 'warn', title: 'PIN incompleto', text: 'Digite os 6 digitos do PIN para abrir a porta.' });
      return;
    }

    const resolution = resolvePickupRequest(lockerStateRef.current, mode, rawValue);
    if (!resolution.ok) {
      setBanner({ tone: 'danger', title: 'Retirada nao autorizada', text: resolution.error });
      return;
    }

    const delivery = resolution.delivery;
    const opened = await actuateDoor(
      delivery.door,
      `Porta ${delivery.door} aberta para retirada do ${getDeliveryUnitLabel(delivery)}.`,
      'pickup'
    );
    if (!opened.ok) return;

    commitState((current) =>
      markPickupDoorOpened(current, delivery.id, opened.cycle, { source: 'local' })
    );
    setActivePickupId(delivery.id);
    setPickupValue('');

    setBanner({
      tone: 'success',
      title: 'Porta aberta para retirada',
      text: `Retire a encomenda da porta ${delivery.door} e toque em Finalizar retirada quando terminar.`,
    });
  }

  async function handleValidatePickup() {
    if (!isPickupCodeReady) {
      setBanner({ tone: 'warn', title: 'Codigo incompleto', text: 'Informe o PIN de 6 digitos ou leia o QR recebido.' });
      return;
    }

    await validatePickupCredential(pickupMode, pickupValue);
  }

  async function handleScannedPickupPayload(rawValue) {
    const credential = resolveScannedPickupCredential(rawValue);
    if (!credential.ok) {
      qrScanLockedRef.current = false;
      setQrScannerState((current) => ({ ...current, error: credential.error, status: 'Tente novamente' }));
      return;
    }

    stopQrScanner();
    setPickupMode(credential.mode);
    setPickupValue(credential.value);
    setQrScannerState({ active: false, status: 'QR lido com sucesso', error: '' });
    await validatePickupCredential(credential.mode, credential.value);
  }

  async function startQrScanner() {
    const mediaDevices = window.navigator?.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      setQrScannerState({
        active: false,
        status: 'idle',
        error: 'Este navegador do armario nao liberou acesso a camera. Digite o PIN.',
      });
      return;
    }

    stopQrScanner({ updateState: false });
    pickupAutoSubmitRef.current = '';
    setPickupMode('predditaQr');
    setPickupValue('');
    setActivePickupId('');
    setQrScannerState({ active: true, status: 'Abrindo camera...', error: '' });

    try {
      const stream = await mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      qrStreamRef.current = stream;
      const video = qrVideoRef.current;
      if (!video) {
        throw new Error('Preview da camera nao esta pronto.');
      }

      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      video.muted = true;
      await video.play();

      setQrScannerState({ active: true, status: 'Aponte o QR recebido para a camera', error: '' });

      const scanLoop = () => {
        const scannedValue = scanQrFromVideo(qrVideoRef.current, qrCanvasRef.current);
        if (scannedValue && !qrScanLockedRef.current) {
          qrScanLockedRef.current = true;
          void handleScannedPickupPayload(scannedValue);
          return;
        }

        qrScanFrameRef.current = window.requestAnimationFrame(scanLoop);
      };

      qrScanFrameRef.current = window.requestAnimationFrame(scanLoop);
    } catch (error) {
      stopQrScanner({ updateState: false });
      setQrScannerState({
        active: false,
        status: 'idle',
        error: 'Nao foi possivel abrir a camera. Confira a permissao e tente novamente.',
      });
      setBanner({
        tone: 'danger',
        title: 'Camera indisponivel',
        text: error?.message || 'O Android nao liberou a camera para leitura do QR.',
      });
    }
  }

  async function handleCompletePickup() {
    if (!activePickup || isBusy) return;

    const pickupToComplete = activePickup;
    setIsBusy(true);

    try {
      const closeProof = await waitForCompletionDoorClosed(
        pickupToComplete.door,
        pickupToComplete.pickupDoorCycle,
        {
        waitingTitle: 'Feche a porta',
        waitingText: `Feche a porta ${pickupToComplete.door}. Assim que o sensor confirmar, a retirada sera finalizada.`,
        timeoutTitle: 'Porta ainda aberta',
        timeoutText: `A porta ${pickupToComplete.door} ainda nao apareceu como fechada. Feche a porta e toque novamente para finalizar.`,
        }
      );

      if (!closeProof) {
        return;
      }

      commitState((current) => completePickup(current, pickupToComplete.id, closeProof));
      const collectedDelivery = eraseDeliveryCredentials({
        ...pickupToComplete,
        status: 'collected',
        collectedAt: closeProof.closedAt,
        pickupCloseProof: closeProof,
      }, closeProof.closedAt);
      queueDeviceEvent('delivery-collected', {
        delivery: collectedDelivery,
        door: pickupToComplete.door,
        source: 'pickup-confirmed',
      }, {
        id: buildDeliveryCollectedEventId(pickupToComplete.id),
      });
      void flushPendingDeviceEvents();
      setPickupValue('');
      setActivePickupId('');
      setPickupSuccessDelivery(collectedDelivery);
      setBanner({
        tone: 'success',
        title: 'Retirada concluida',
        text: `${getDeliveryUnitLabel(pickupToComplete)} finalizou a coleta da porta ${pickupToComplete.door}.`,
      });
    } catch (error) {
      setBanner({
        tone: 'danger',
        title: 'Retirada nao finalizada',
        text: error?.message || 'A leitura da porta falhou. Feche a porta e tente novamente.',
      });
    } finally {
      setIsBusy(false);
    }
  }

  function handleApplyDeviceConfig() {
    const nextState = updateDeviceConfig(lockerState, {
      board: deviceForm.board,
      doorCount: deviceForm.doorCount,
      sensorPolarity: deviceForm.sensorPolarity,
    });
    commitState(nextState);
    setDoorPage(0);
    setBanner({
      tone: 'success',
      title: 'Configuracao aplicada',
      text: `Board ${nextState.deviceConfig.board} com ${nextState.deviceConfig.doorCount} portas e perfil de sensor aplicado.`,
    });
  }

  function handleCommissioningComplete(payload) {
    const nextState = applyDeviceCommissioning(lockerStateRef.current, payload);
    commitState(nextState);
    setDoorPage(0);
    setBanner({
      tone: 'success',
      title: 'Comissionamento concluido',
      text: `${nextState.deviceConfig.doorCount} portas foram mapeadas e validadas fisicamente.`,
    });
    return nextState.deviceConfig;
  }

  function resetCourierFlow() {
    smallCloseCancelRef.current = true;
    courierCancelRequestedRef.current = false;
    setCourierStep('recipient');
    setCourierDepositStage('small');
    setSmallCloseSecondsLeft(0);
    setSelectedRecipientId('');
    setRecipientSearch('');
    setCourierSuccessDelivery(null);
    resetLabelCapture();
    setDeliveryForm((current) => ({ ...current, packageSize: '' }));
  }

  function openCourierFlow() {
    setGeneratedDelivery(null);
    setCourierSuccessDelivery(null);
    setActiveDepositId('');
    setBanner(PUBLIC_READY_BANNER);
    resetCourierFlow();
    setView('courier');
  }

  function openResidentFlow() {
    setBanner(PUBLIC_READY_BANNER);
    pickupAutoSubmitRef.current = '';
    setPickupValue('');
    setActivePickupId('');
    setPickupSuccessDelivery(null);
    setView('resident');
  }

  async function handleSelectRecipient(recipientId) {
    setSelectedRecipientId(recipientId);
    if (view === 'courier') {
      setCourierSuccessDelivery(null);
      setCourierStep('confirm');
      setBanner({
        tone: 'success',
        title: 'Confirme o apartamento',
        text: 'Revise a unidade antes de abrir a porta pequena.',
      });
    }
  }

  async function handleConfirmCourierRecipient() {
    if (!selectedRecipient) {
      setBanner({ tone: 'danger', title: 'Apartamento obrigatorio', text: 'Selecione um apartamento para continuar.' });
      return;
    }
    await openCourierSmallDoor(selectedRecipient.id);
  }

  function handleBackToApartmentList() {
    setCourierStep('recipient');
    setSelectedRecipientId('');
    setBanner(PUBLIC_READY_BANNER);
  }

  function handleApartmentKey(value) {
    setRecipientSearch((current) => `${current}${value}`.slice(0, 8));
  }

  function handleApartmentBackspace() {
    setRecipientSearch((current) => current.slice(0, -1));
  }

  function handlePickupValueChange(event) {
    const value = event.target.value;
    setPickupValue(pickupMode === 'pin' ? value.replace(/\D/g, '').slice(0, 6) : value);
  }

  function handlePickupDigit(value) {
    pickupAutoSubmitRef.current = '';
    setPickupMode('pin');
    setPickupValue((current) => applyDigitKey(current, value));
  }

  function handlePickupBackspace() {
    pickupAutoSubmitRef.current = '';
    setPickupValue((current) => applyBackspaceKey(current));
  }

  function handlePickupClear() {
    pickupAutoSubmitRef.current = '';
    setPickupValue('');
  }

  function finishPickupSuccessNow() {
    stopQrScanner();
    pickupAutoSubmitRef.current = '';
    setPickupValue('');
    setActivePickupId('');
    setPickupSuccessDelivery(null);
    setView('home');
    setBanner(PUBLIC_READY_BANNER);
  }

  function buildRemoteDoorStatus() {
    return doorCards.map((door) => ({
      channel: door.channel,
      label: door.label,
      size: door.size,
      status: door.physicalState.status,
      occupancy: door.delivery ? 'busy' : 'free',
      delivery: door.delivery
        ? {
            id: door.delivery.id,
            recipientName: door.delivery.recipientName,
            unit: door.delivery.unit,
            status: door.delivery.status,
          }
        : null,
    }));
  }

  function buildRemoteDeliveryStatus() {
    return lockerState.deliveries.map((delivery) => ({
      id: delivery.id,
      recipientId: delivery.recipientId,
      recipientName: delivery.recipientName,
      recipientEmail: delivery.recipientEmail,
      unit: delivery.unit,
      building: delivery.building,
      courierName: delivery.courierName,
      orderCode: delivery.orderCode,
      externalCode: delivery.externalCode,
      door: delivery.door,
      doorSize: delivery.doorSize,
      size: delivery.size,
      pin: delivery.pin,
      token: delivery.token,
      qrPayload: delivery.qrPayload,
      status: delivery.status,
      notificationStatus: delivery.notificationStatus,
      notificationRequestedAt: delivery.notificationRequestedAt,
      notificationSentAt: delivery.notificationSentAt,
      notificationError: delivery.notificationError,
      notificationMessageId: delivery.notificationMessageId,
      labelPhotoCapturedAt: delivery.labelPhotoCapturedAt,
      labelOcrStatus: delivery.labelOcrStatus,
      labelOcrApartment: delivery.labelOcrApartment,
      labelProofRequired: delivery.labelProofRequired,
      reminderLevel: delivery.reminderLevel,
      reminderLastQueuedAt: delivery.reminderLastQueuedAt,
      reminderLastSentAt: delivery.reminderLastSentAt,
      reminderError: delivery.reminderError,
      createdAt: delivery.createdAt,
      depositedAt: delivery.depositedAt,
      pickupOpenedAt: delivery.pickupOpenedAt,
      collectedAt: delivery.collectedAt,
      cancelledAt: delivery.cancelledAt,
      cancelReason: delivery.cancelReason,
      expiresAt: delivery.expiresAt,
      dropoffDoorCycle: delivery.dropoffDoorCycle,
      dropoffCloseProof: delivery.dropoffCloseProof,
      pickupDoorCycle: delivery.pickupDoorCycle,
      pickupCloseProof: delivery.pickupCloseProof,
      pickupSource: delivery.pickupSource,
    }));
  }

  function syncRemoteResidents(recipients, nextRevision = '') {
    if (!Array.isArray(recipients)) return;
    if (nextRevision && nextRevision === remoteResidentsRevisionRef.current) return;
    const syncedAt = new Date().toISOString();

    commitState((current) => ({
      ...current,
      recipients,
      remoteResidentsRevision: nextRevision,
      residentsSyncedAt: syncedAt,
      updatedAt: new Date().toISOString(),
    }));
    remoteResidentsRevisionRef.current = nextRevision;

    if (!recipients.some((recipient) => recipient.id === selectedRecipientId)) {
      setSelectedRecipientId('');
    }
  }

  function applyRemoteEventNotifications(notifications = []) {
    const validNotifications = Array.isArray(notifications)
      ? notifications.filter((item) => item?.deliveryId && item.notification)
      : [];
    if (validNotifications.length === 0) return;

    commitState((current) =>
      validNotifications.reduce(
        (nextState, item) => markDeliveryNotification(nextState, item.deliveryId, item.notification),
        current
      )
    );

    const patches = new Map(validNotifications.map((item) => [
      item.deliveryId,
      {
        notificationStatus: item.notification.status,
        notificationRequestedAt: item.notification.requestedAt,
        notificationSentAt: item.notification.sentAt,
        notificationError: item.notification.error,
        notificationMessageId: item.notification.messageId,
      },
    ]));

    setGeneratedDelivery((current) => current && patches.has(current.id) ? { ...current, ...patches.get(current.id) } : current);
    setCourierSuccessDelivery((current) => current && patches.has(current.id) ? { ...current, ...patches.get(current.id) } : current);
  }

  async function flushPendingDeviceEvents() {
    return edgeAgent.flushPendingEvents({
      onNotifications: applyRemoteEventNotifications,
    });
  }

  async function executeRemoteDoor({ door }) {
    const opened = await actuateDoor(
      door,
      `Porta ${door} acionada por comando remoto do sindico.`,
      'remote-admin',
    );
    const occupiedDelivery = lockerStateRef.current.deliveries.find(
      (delivery) =>
        delivery.door === door &&
        ['door_opened_for_dropoff', 'stored', 'pickup_opened'].includes(delivery.status),
    );
    const pickupPendingClose = Boolean(
      opened.ok && occupiedDelivery && ['stored', 'pickup_opened'].includes(occupiedDelivery.status),
    );
    if (pickupPendingClose) {
      commitState((current) =>
        markPickupDoorOpened(current, occupiedDelivery.id, opened.cycle, {
          source: 'remote-admin',
        }),
      );
    }

    return {
      ok: opened.ok,
      confirmed: opened.confirmed,
      reason: opened.reason,
      error: opened.error,
      releasedDoor: false,
      releasedDeliveryId: '',
      pendingPhysicalClose: pickupPendingClose,
      physicalOpenCycle: opened.cycle ?? null,
    };
  }

  async function processRemoteBridge() {
    const hasOpenDoorWorkflow = lockerState.deliveries.some((delivery) =>
      ['door_opened_for_dropoff', 'pickup_opened'].includes(delivery.status),
    );
    return edgeAgent.runRemoteCycle({
      doorCount: lockerState.deviceConfig.doorCount,
      canInstallUpdate: !isBusy && view === 'home' && !hasOpenDoorWorkflow,
      status: {
        device: {
          serialOpen: hardwareInfo.serialOpen,
          serialPath: hardwareInfo.serialPath,
          bridgeVersion: hardwareInfo.bridgeVersion,
          edgeAppVersion: APP_VERSION,
          board: lockerState.deviceConfig.board,
          doorCount: lockerState.deviceConfig.doorCount,
          sensorPolarity: lockerState.deviceConfig.sensorPolarity,
          unlockTimeoutSeconds: lockerState.deviceConfig.unlockTimeoutSeconds,
          doorSizes: lockerState.deviceConfig.doorSizes,
          commissioningStatus: lockerState.deviceConfig.commissioning?.status || 'pending',
          commissionedAt: lockerState.deviceConfig.commissioning?.completedAt || '',
          residentCount: lockerState.recipients.length,
          residentsSyncedAt: lockerState.residentsSyncedAt || '',
          remoteResidentsRevision: lockerState.remoteResidentsRevision || '',
        },
        doors: buildRemoteDoorStatus(),
        deliveries: buildRemoteDeliveryStatus(),
      },
      onResidents: syncRemoteResidents,
      onNotifications: applyRemoteEventNotifications,
      onOpenDoor: executeRemoteDoor,
    });
  }

  async function reconcileRemotePickupClosures() {
    if (remoteCloseInFlightRef.current || isBusy) return false;

    const delivery = lockerStateRef.current.deliveries.find(
      (item) =>
        item.status === 'pickup_opened' &&
        item.pickupSource === 'remote-admin' &&
        item.pickupDoorCycle
    );
    if (!delivery) return false;

    remoteCloseInFlightRef.current = true;
    try {
      const reading = await readDoorPhysicalStatus(delivery.door);
      const closeResult = createDoorCloseProof(delivery.pickupDoorCycle, reading);
      if (!closeResult.ok) return false;

      const completedDelivery = {
        ...delivery,
        status: 'collected',
        collectedAt: closeResult.proof.closedAt,
        pickupCloseProof: closeResult.proof,
      };
      commitState((current) => completePickup(current, delivery.id, closeResult.proof));
      queueDeviceEvent(
        'delivery-collected',
        {
          delivery: completedDelivery,
          door: delivery.door,
          source: 'remote-admin-physical-close',
        },
        {
          id: buildDeliveryCollectedEventId(delivery.id),
          occurredAt: closeResult.proof.closedAt,
        }
      );
      void flushPendingDeviceEvents();
      setBanner({
        tone: 'success',
        title: `Porta ${delivery.door} fechada`,
        text: 'A abertura remota foi finalizada apos confirmacao fisica do sensor.',
      });
      return true;
    } finally {
      remoteCloseInFlightRef.current = false;
    }
  }

  remoteCycleRunnerRef.current = async () => {
    if (isBusy) return;
    await reconcileRemotePickupClosures();
    await processRemoteBridge();
  };
  remotePickupReconcileRef.current = async () => {
    if (isBusy) return;
    await reconcileRemotePickupClosures();
  };

  useEffect(() => {
    const timer = window.setInterval(() => {
      void remotePickupReconcileRef.current?.();
    }, 6000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let stopped = false;
    let running = false;
    let wakeQueued = false;
    let timer = null;

    const schedule = (run) => {
      const wakeup = edgeAgent.getCommandWakeupStatus();
      const delay = wakeup.connected ? wakeup.healthyPollMs : wakeup.fallbackPollMs;
      timer = window.setTimeout(run, Math.max(1000, Number(delay) || 6000));
    };
    const run = async (trigger = 'poll') => {
      if (stopped) return;
      if (running) {
        if (trigger === 'wake') wakeQueued = true;
        return;
      }
      running = true;
      if (timer) window.clearTimeout(timer);
      timer = null;
      try {
        await remoteCycleRunnerRef.current?.();
      } finally {
        running = false;
        if (stopped) return;
        if (wakeQueued) {
          wakeQueued = false;
          timer = window.setTimeout(() => void run('wake'), 0);
        } else {
          schedule(() => void run('poll'));
        }
      }
    };

    void edgeAgent.startCommandWakeup({ onWake: () => run('wake') });
    timer = window.setTimeout(() => void run('initial'), 1800);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      edgeAgent.stopCommandWakeup();
    };
  }, []);

  useEffect(() => {
    if (view !== 'courier' || !activeDeposit || courierDepositStage !== 'large') {
      return undefined;
    }

    const timer = setTimeout(() => {
      setBanner({
        tone: 'warn',
        title: 'Confirme o deposito',
        text: `A porta ${activeDeposit.door} esta aguardando. Toque em Item guardado somente depois de colocar a encomenda e fechar a porta.`,
      });
    }, 60000);

    return () => clearTimeout(timer);
  }, [view, activeDeposit?.id, courierDepositStage]);

  useEffect(() => {
    if (view !== 'courier' || courierStep !== 'success' || !courierSuccessDelivery?.recipientEmail) {
      return undefined;
    }

    const timer = setTimeout(() => {
      finishCourierSuccessNow();
    }, COURIER_SUCCESS_RETURN_MS);

    return () => clearTimeout(timer);
  }, [view, courierStep, courierSuccessDelivery?.id, courierSuccessDelivery?.recipientEmail]);

  useEffect(() => {
    if (view !== 'resident' || !pickupSuccessDelivery) {
      return undefined;
    }

    const timer = setTimeout(() => {
      finishPickupSuccessNow();
    }, COURIER_SUCCESS_RETURN_MS);

    return () => clearTimeout(timer);
  }, [view, pickupSuccessDelivery?.id]);

  return (
    <main className={joinClasses('locker-app', isHomeView || isPublicFlowView ? 'locker-app--public' : '', isHomeView ? 'locker-app--kiosk-v4-home' : '', isPublicFlowView ? 'locker-app--kiosk-v4-flow' : '')}>
      <div className={joinClasses('locker-shell', isHomeView ? 'locker-shell--home' : '', isPublicFlowView ? 'locker-shell--flow' : '', showInlineBanner ? 'locker-shell--has-banner' : '', isAdminView ? 'locker-shell--admin' : '')}>
        {!isHomeView && !isPublicFlowView ? (
        <section className="hero-card">
          <div className="hero-top">
            <div className="hero-copy">
              <p className="hero-kicker">{lockerState.tenant.siteName}</p>
              <h1 className="hero-title">{isPublicFlowView ? publicPageTitle : 'PREDDITA Entregas'}</h1>
              <p className="hero-text">{isPublicFlowView ? publicPageText : 'Deposito, retirada e leitura local do locker.'}</p>
            </div>
            {isPublicFlowView ? (
              <button
                type="button"
                className="ghost-button back-button"
                onClick={() => {
                  if (view === 'courier' && !activeDeposit) {
                    setGeneratedDelivery(null);
                    resetCourierFlow();
                  }
                  setView('home');
                }}
              >
                Voltar
              </button>
            ) : (
              <div className="pill-row">
                <Pill>{edgeAgent.isNative() ? 'Modo nativo no locker' : 'Modo simulacao web'}</Pill>
                <Pill tone={hardwareInfo.serialOpen ? '' : 'danger'}>
                  {hardwareInfo.serialOpen ? `Serial ${hardwareInfo.serialPath}` : 'Serial indisponivel'}
                </Pill>
                <Pill>Bridge {hardwareInfo.bridgeVersion}</Pill>
                <Pill tone="warn">Board {lockerState.deviceConfig.board} - {lockerState.deviceConfig.doorCount} portas</Pill>
              </div>
            )}
          </div>
        </section>
        ) : null}

        {isAdminView ? (
        <nav className={joinClasses('top-nav', isAdminView ? 'top-nav--admin' : 'top-nav--public')}>
          <button type="button" className="nav-button" onClick={() => setView('home')}>Menu</button>
          <button type="button" className={joinClasses('nav-button', view === 'admin' ? 'is-active' : '')} onClick={() => setView('admin')}>Painel</button>
          <button type="button" className={joinClasses('nav-button', view === 'adminDeposit' ? 'is-active' : '')} onClick={() => setView('adminDeposit')}>Depositar</button>
          <button type="button" className={joinClasses('nav-button', view === 'adminPickup' ? 'is-active' : '')} onClick={() => setView('adminPickup')}>Retirar</button>
          <button type="button" className={joinClasses('nav-button', view === 'doors' ? 'is-active' : '')} onClick={() => setView('doors')}>Portas</button>
          <button type="button" className={joinClasses('nav-button', view === 'system' ? 'is-active' : '')} onClick={() => setView('system')}>Sistema</button>
        </nav>
        ) : null}

        {showInlineBanner ? (
        <section className={joinClasses('banner', banner.tone ? `is-${banner.tone}` : '')}>
          <h2 className="banner-title">{banner.title}</h2>
          <p className="banner-text">{banner.text}</p>
        </section>
        ) : null}

        <section className={joinClasses('workspace', view === 'doors' || view === 'system' ? 'workspace--split' : 'workspace--single')}>
          {view === 'home' || view === 'courier' || view === 'resident' || view === 'admin' || view === 'adminDeposit' || view === 'adminPickup' ? (
          <div className="main-column">
            {view === 'home' ? (
              <PublicHome siteName={lockerState.tenant.siteName} onCourier={openCourierFlow} onResident={openResidentFlow} />
            ) : null}

            {view === 'admin' ? (
              <section className="panel-card view-panel view-panel--home">
                <div className="panel-header">
                  <div>
                    <h2 className="panel-title">Painel administrador</h2>
                    <p className="panel-text">Visao completa do locker, com atalhos de operacao e diagnostico.</p>
                  </div>
                  <div className="action-row">
                    <button type="button" className="action-button" onClick={() => setView('adminDeposit')}>Nova entrega</button>
                    <button type="button" className="action-button is-secondary" onClick={() => setView('adminPickup')}>Liberar retirada</button>
                    <button type="button" className="ghost-button" onClick={() => setView('doors')}>Ver portas</button>
                  </div>
                </div>

                <div className="stats-grid stats-grid--compact">
                  <StatCard label="Portas livres" value={`${freeDoorCount}/${doorCatalog.length}`} hint="Sem encomenda ativa." />
                  <StatCard label="Ocupadas" value={occupiedDoorCount} hint="Encomendas armazenadas." />
                  <StatCard label="Abertas" value={openDoorCount} hint="Retorno fisico atual." />
                  <StatCard label="Ultima leitura" value={lastSyncAt ? formatDateTime(lastSyncAt) : '--'} hint="Mapa sincronizado." />
                </div>

                <div className="quick-grid quick-grid--home">
                  <article className="info-card">
                    <p className="info-kicker">Proxima vaga</p>
                    <h3 className="info-title">{recommendedDoor ? `Porta ${recommendedDoor.channel} - ${recommendedDoor.size}` : 'Sem vaga compativel'}</h3>
                    <p className="info-text">A menor porta livre compativel aparece aqui.</p>
                  </article>
                  <article className="info-card">
                    <p className="info-kicker">Retirada pronta</p>
                    <h3 className="info-title">{collectibleDeliveries[0] ? `${getDeliveryUnitLabel(collectibleDeliveries[0])} - porta ${collectibleDeliveries[0].door}` : 'Nenhuma retirada aguardando'}</h3>
                    <p className="info-text">
                      {collectibleDeliveries[0] ? `PIN ${collectibleDeliveries[0].pin} ate ${formatDateTime(collectibleDeliveries[0].expiresAt)}.` : 'Quando houver item confirmado, ele aparece aqui.'}
                    </p>
                  </article>
                  <article className="info-card">
                    <p className="info-kicker">Portas em destaque</p>
                    <div className="door-grid door-grid--preview">
                      {homeDoorPreview.map((door) => (
                        <DoorCard key={door.channel} door={door} />
                      ))}
                    </div>
                  </article>
                  <article className="info-card">
                    <p className="info-kicker">Auditoria recente</p>
                    <div className="audit-list audit-list--compact">
                      {recentAudit.map((entry) => (
                        <AuditCard key={entry.id} entry={entry} />
                      ))}
                    </div>
                  </article>
                </div>
              </section>
            ) : null}

            {view === 'courier' ? (
              <section className="public-kiosk-host">
                {courierStep === 'success' && courierSuccessDelivery && courierSuccessPresentation ? (
                  <CourierSuccessStep
                    tenantName={lockerState.tenant.siteName}
                    presentation={courierSuccessPresentation}
                    delivery={courierSuccessDelivery}
                    qrImage={qrImage}
                    onNewDelivery={openCourierFlow}
                    onHome={finishCourierSuccessNow}
                  />
                ) : activeDeposit ? (
                  <CourierDoorStep
                    tenantName={lockerState.tenant.siteName}
                    delivery={activeDeposit}
                    stage={courierDepositStage}
                    secondsLeft={smallCloseSecondsLeft}
                    isBusy={isBusy}
                    onStored={handleConfirmDeposit}
                    onDoesNotFit={handleUseLargeDoor}
                    onCancel={handleCancelWaitingForLargeDoor}
                  />
                ) : courierStep === 'confirm' && selectedRecipient ? (
                  <CourierConfirmStep
                    tenantName={lockerState.tenant.siteName}
                    recipient={selectedRecipient}
                    isBusy={isBusy}
                    onBack={handleBackToApartmentList}
                    onConfirm={handleConfirmCourierRecipient}
                  />
                ) : (
                  <CourierApartmentStep
                    tenantName={lockerState.tenant.siteName}
                    search={recipientSearch}
                    recipients={filteredRecipients}
                    onSearchChange={setRecipientSearch}
                    onKey={handleApartmentKey}
                    onBackspace={handleApartmentBackspace}
                    onClear={() => setRecipientSearch('')}
                    onSelectRecipient={handleSelectRecipient}
                    onBack={() => {
                      resetCourierFlow();
                      setView('home');
                    }}
                  />
                )}
              </section>
            ) : null}

            {view === 'adminDeposit' ? (
              <section className="panel-card view-panel view-panel--deposit">
                <div className="panel-header">
                  <div>
                    <h2 className="panel-title">Fluxo de deposito</h2>
                    <p className="panel-text">Escolha o apartamento, informe o volume e abra uma porta disponivel.</p>
                  </div>
                  <button type="button" className="ghost-button" onClick={() => syncHardwareStatus()} disabled={isSyncing}>
                    {isSyncing ? 'Sincronizando...' : 'Atualizar mapa'}
                  </button>
                </div>

                {!activeDeposit ? (
                  <div className="operation-grid operation-grid--split">
                    <section className="panel-card inset-card">
                      <div className="field">
                        <label className="field-label" htmlFor="recipient-search">Buscar apartamento</label>
                        <input id="recipient-search" className="text-input" type="text" inputMode="numeric" value={recipientSearch} placeholder="Digite o numero do apartamento" onChange={(event) => setRecipientSearch(event.target.value)} />
                      </div>
                      <div className="recipient-list recipient-list--tall">
                        {filteredRecipients.map((recipient) => (
                          <RecipientCard key={recipient.id} recipient={recipient} selected={recipient.id === selectedRecipientId} onSelect={() => handleSelectRecipient(recipient.id)} />
                        ))}
                        {filteredRecipients.length === 0 ? <div className="empty-state"><p className="empty-text">Nenhum apartamento encontrado.</p></div> : null}
                      </div>
                    </section>

                    <section className="panel-card inset-card">
                      <div className="summary-shell">
                        <div className="summary-grid">
                          <div><span className="summary-label">Apartamento</span><p className="summary-value">{selectedRecipient ? formatRecipientApartment(selectedRecipient) : 'Nao selecionado'}</p></div>
                          <div><span className="summary-label">Unidade</span><p className="summary-value">{selectedRecipient ? selectedRecipient.unit : '--'}</p></div>
                          <div><span className="summary-label">Porta sugerida</span><p className="summary-value">{recommendedDoor ? `Porta ${recommendedDoor.channel} - ${recommendedDoor.size}` : 'Sem vaga'}</p></div>
                          <div><span className="summary-label">Livres</span><p className="summary-value">{freeDoorCount}</p></div>
                        </div>
                      </div>

                      <div className="form-grid form-grid--compact">
                        <div className="config-grid">
                          <div className="field">
                            <label className="field-label" htmlFor="courier-name">Origem</label>
                            <input id="courier-name" className="text-input" type="text" value={deliveryForm.courierName} onChange={(event) => setDeliveryForm((current) => ({ ...current, courierName: event.target.value }))} />
                          </div>
                          <div className="field">
                            <label className="field-label" htmlFor="order-code">Referencia</label>
                            <input id="order-code" className="text-input" type="text" value={deliveryForm.orderCode} placeholder="Pedido ou protocolo" onChange={(event) => setDeliveryForm((current) => ({ ...current, orderCode: event.target.value }))} />
                          </div>
                        </div>

                        <div className="size-selector">
                          {PACKAGE_SIZES.map((size) => (
                            <button key={size.id} type="button" className={joinClasses('size-button', deliveryForm.packageSize === size.id ? 'is-active' : '')} onClick={() => setDeliveryForm((current) => ({ ...current, packageSize: size.id }))}>
                              <span className="size-title">{size.label}</span>
                              <span className="size-hint">{size.hint}</span>
                            </button>
                          ))}
                        </div>

                        <div className="config-grid">
                          <div className="field">
                            <label className="field-label" htmlFor="external-code">QR externo</label>
                            <input id="external-code" className="text-input" type="text" value={deliveryForm.externalCode} placeholder="Opcional" onChange={(event) => setDeliveryForm((current) => ({ ...current, externalCode: event.target.value }))} />
                          </div>
                          <div className="field">
                            <label className="field-label" htmlFor="delivery-notes">Observacoes</label>
                            <textarea id="delivery-notes" className="text-area text-area--compact" value={deliveryForm.notes} placeholder="Observacoes internas" onChange={(event) => setDeliveryForm((current) => ({ ...current, notes: event.target.value }))} />
                          </div>
                        </div>

                        <div className="action-row">
                          <button type="button" className="action-button" onClick={handleCreateDeposit} disabled={isBusy || !recommendedDoor}>
                            {isBusy ? 'Abrindo porta...' : 'Abrir compartimento'}
                          </button>
                        </div>
                      </div>
                    </section>
                  </div>
                ) : (
                  <DeliveryCard
                    delivery={activeDeposit}
                    titleOverride="Entrega em andamento"
                    footer={
                      <>
                        <div className="summary-shell">
                          <div className="summary-grid">
                            <div><span className="summary-label">PIN</span><p className="summary-value">{activeDeposit.pin}</p></div>
                            <div><span className="summary-label">Expira em</span><p className="summary-value">{formatDateTime(activeDeposit.expiresAt)}</p></div>
                            <div><span className="summary-label">QR PREDDITA</span><p className="summary-value">{trimCode(activeDeposit.qrPayload)}</p></div>
                            <div><span className="summary-label">Notificacao</span><p className="summary-value">Pronta para envio</p></div>
                          </div>
                        </div>
                        <div className="preview-shell preview-shell--compact">{buildNotificationPreview(activeDeposit)}</div>
                        <div className="action-row">
                          <button type="button" className="action-button" onClick={handleConfirmDeposit}>Confirmar item guardado</button>
                          <button type="button" className="action-button is-danger" onClick={handleCancelDeposit}>Cancelar reserva</button>
                        </div>
                      </>
                    }
                  />
                )}

                {generatedDelivery && !activeDeposit ? (
                  <article className="credential-card">
                    <div className="credential-copy">
                      <p className="info-kicker">Codigo gerado</p>
                      <h3 className="credential-pin">{generatedDelivery.pin}</h3>
                      <p className="info-text">
                        Porta {generatedDelivery.door} liberada para {getDeliveryUnitLabel(generatedDelivery)}. {getDeliveryNotificationText(generatedDelivery)}
                      </p>
                    </div>
                    <div className="qr-shell">
                      {qrImage ? <img className="qr-image" src={qrImage} alt="QR de retirada" /> : null}
                      <p className="qr-caption">{trimCode(generatedDelivery.qrPayload)}</p>
                    </div>
                  </article>
                ) : null}
              </section>
            ) : null}

            {view === 'resident' ? (
              <section className="public-kiosk-host">
                <ResidentPickupStep
                  tenantName={lockerState.tenant.siteName}
                  mode={pickupMode}
                  value={pickupValue}
                  presentation={pickupEntryPresentation}
                  isBusy={isBusy}
                  qrScannerState={qrScannerState}
                  activePickup={activePickup}
                  completedPickup={pickupSuccessDelivery}
                  qrVideoRef={qrVideoRef}
                  qrCanvasRef={qrCanvasRef}
                  onBack={() => {
                    stopQrScanner();
                    setPickupValue('');
                    setActivePickupId('');
                    setPickupSuccessDelivery(null);
                    setView('home');
                  }}
                  onHome={finishPickupSuccessNow}
                  onModeChange={(nextMode) => {
                    stopQrScanner();
                    pickupAutoSubmitRef.current = '';
                    setPickupMode(nextMode);
                    setPickupValue('');
                    setActivePickupId('');
                    setPickupSuccessDelivery(null);
                  }}
                  onDigit={handlePickupDigit}
                  onClear={handlePickupClear}
                  onBackspace={handlePickupBackspace}
                  onValidate={handleValidatePickup}
                  onCompletePickup={handleCompletePickup}
                  onStartQr={startQrScanner}
                  onStopQr={stopQrScanner}
                />
              </section>
            ) : null}

            {view === 'adminPickup' ? (
              <section className="panel-card view-panel view-panel--pickup">
                <div className="panel-header">
                  <div>
                    <h2 className="panel-title">Fluxo de retirada</h2>
                    <p className="panel-text">Valide o codigo ou QR e abra a porta correta.</p>
                  </div>
                </div>

                <div className="operation-grid operation-grid--split">
                  <section className="panel-card inset-card">
                    <div className="pickup-methods pickup-methods--compact">
                      {pickupMethodsForView.map((method) => (
                        <button key={method.id} type="button" className={joinClasses('method-button', pickupMode === method.id ? 'is-active' : '')} onClick={() => { pickupAutoSubmitRef.current = ''; setPickupMode(method.id); setPickupValue(''); setActivePickupId(''); }}>
                          <span className="method-title">{method.title}</span>
                          <span className="method-hint">{method.hint}</span>
                        </button>
                      ))}
                    </div>

                    <div className="config-grid config-grid--actions">
                      <div className="field">
                        <label className="field-label" htmlFor="pickup-value">Codigo de retirada</label>
                        <input id="pickup-value" className="text-input" type="text" value={pickupValue} placeholder={pickupMode === 'pin' ? 'PIN de 6 digitos' : pickupMode === 'predditaQr' ? 'Payload preddita://collect' : 'QR externo cadastrado'} onChange={handlePickupValueChange} />
                      </div>
                      <div className="action-row action-row--stretch">
                        <button type="button" className="action-button" onClick={handleValidatePickup} disabled={isBusy || !isPickupCodeReady}>
                          {isBusy ? 'Validando...' : 'Validar e abrir'}
                        </button>
                      </div>
                    </div>

                    {activePickup ? (
                      <DeliveryCard
                        delivery={activePickup}
                        tone="warn"
                        titleOverride="Retirada liberada"
                        footer={<div className="action-row"><button type="button" className="action-button is-secondary" onClick={handleCompletePickup} disabled={isBusy}>{isBusy ? 'Verificando porta...' : 'Confirmar retirada'}</button></div>}
                      />
                    ) : (
                      <div className="empty-state"><p className="empty-text">Quando o codigo for validado, a entrega ativa aparece aqui.</p></div>
                    )}
                  </section>

                  <section className="panel-card inset-card">
                    <div className="side-header">
                      <h2 className="side-title">Entregas prontas</h2>
                      <span className="small-copy">{collectibleDeliveries.length} aguardando cliente</span>
                    </div>
                    <div className="delivery-list delivery-list--tall">
                      {collectibleDeliveries.map((delivery) => (
                        <DeliveryCard key={delivery.id} delivery={delivery} />
                      ))}
                      {collectibleDeliveries.length === 0 ? <div className="empty-state"><p className="empty-text">Nao ha encomendas aguardando retirada.</p></div> : null}
                    </div>
                  </section>
                </div>
              </section>
            ) : null}
          </div>
          ) : null}

          {view === 'doors' || view === 'system' ? (
          <aside className={joinClasses('side-column', view === 'system' ? 'side-column--system' : '')}>
            {view === 'doors' ? (
              <section className="panel-card view-panel view-panel--doors">
                <div className="side-header">
                  <div>
                    <h2 className="side-title">Mapa do locker</h2>
                    <p className="panel-text">Leitura visual das portas com pagina dedicada para toque.</p>
                  </div>
                  <span className="small-copy">{occupiedDoorCount} ocupadas - {freeDoorCount} livres</span>
                </div>
                <div className="stats-grid stats-grid--doors">
                  <StatCard label="Portas" value={lockerState.deviceConfig.doorCount} hint={`Board ${lockerState.deviceConfig.board}`} />
                  <StatCard label="Leitura" value={lastSyncAt ? formatDateTime(lastSyncAt) : '--'} hint="Ultimo retorno da placa." />
                  <StatCard label="Abertas" value={openDoorCount} hint="Sensor aberto agora." />
                  <StatCard label="Pagina" value={`${doorPage + 1}/${doorPageCount}`} hint={`Portas ${doorPageStart} a ${doorPageEnd}`} />
                </div>
                <div className="door-grid door-grid--paged">
                  {visibleDoorCards.map((door) => (
                    <DoorCard key={door.channel} door={door} />
                  ))}
                </div>
                <div className="pager-row">
                  <button type="button" className="ghost-button" onClick={() => setDoorPage((current) => Math.max(0, current - 1))} disabled={doorPage === 0}>
                    Pagina anterior
                  </button>
                  <div className="summary-shell summary-shell--inline">
                    <span className="summary-label">Exibindo</span>
                    <p className="summary-value">Portas {doorPageStart} a {doorPageEnd}</p>
                  </div>
                  <button type="button" className="ghost-button" onClick={() => setDoorPage((current) => Math.min(doorPageCount - 1, current + 1))} disabled={doorPage >= doorPageCount - 1}>
                    Proxima pagina
                  </button>
                </div>
              </section>
            ) : null}

            {view === 'system' ? (
              <>
                <section className="panel-card view-panel view-panel--system">
                  <div className="side-header">
                    <div>
                      <h2 className="side-title">Configuracao do dispositivo</h2>
                      <p className="panel-text">Ajustes rapidos do locker e leitura de diagnostico.</p>
                    </div>
                    <button type="button" className="ghost-button" onClick={() => syncHardwareStatus()} disabled={isSyncing}>
                      {isSyncing ? 'Lendo placa...' : 'Forcar leitura'}
                    </button>
                  </div>
                  <div className="config-grid">
                    <div className="field">
                      <label className="field-label" htmlFor="board-input">Board RS-485</label>
                      <input id="board-input" className="text-input" type="number" min="1" max="31" value={deviceForm.board} onChange={(event) => setDeviceForm((current) => ({ ...current, board: event.target.value }))} />
                    </div>
                    <div className="field">
                      <label className="field-label" htmlFor="door-count-input">Quantidade de portas</label>
                      <input id="door-count-input" className="text-input" type="number" min="1" max="24" value={deviceForm.doorCount} onChange={(event) => setDeviceForm((current) => ({ ...current, doorCount: event.target.value }))} />
                    </div>
                    <div className="field">
                      <label className="field-label" htmlFor="sensor-polarity-input">Polaridade do sensor</label>
                      <select
                        id="sensor-polarity-input"
                        className="text-input"
                        value={deviceForm.sensorPolarity}
                        onChange={(event) => setDeviceForm((current) => ({
                          ...current,
                          sensorPolarity: event.target.value,
                        }))}
                      >
                        {SENSOR_POLARITY_OPTIONS.map((option) => (
                          <option key={option.id} value={option.id}>{option.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="preset-row">
                    {DOOR_COUNT_PRESETS.map((count) => (
                      <button
                        key={count}
                        type="button"
                        className={joinClasses('preset-button', String(count) === String(deviceForm.doorCount) ? 'is-active' : '')}
                        onClick={() => setDeviceForm((current) => ({ ...current, doorCount: String(count) }))}
                      >
                        {count} portas
                      </button>
                    ))}
                  </div>
                  <div className="action-row">
                    <button type="button" className="action-button" onClick={handleApplyDeviceConfig}>Aplicar configuracao</button>
                  </div>
                  <div className="stats-grid stats-grid--system">
                    <StatCard label="Serial" value={hardwareInfo.serialOpen ? 'OK' : 'Falha'} hint={hardwareInfo.serialOpen ? hardwareInfo.serialPath : 'Sem resposta'} />
                    <StatCard label="Bridge" value={trimCode(hardwareInfo.bridgeVersion)} hint="Camada nativa ativa." />
                    <StatCard label="Portas" value={lockerState.deviceConfig.doorCount} hint="Quantidade configurada." />
                    <StatCard label="Sensor" value={lockerState.deviceConfig.sensorPolarity === 'zeroClosed' ? '0x00 fechada' : '0x00 aberta'} hint="Perfil individual ativo." />
                    <StatCard label="Acionamento" value={`${lockerState.deviceConfig.unlockTimeoutSeconds}s`} hint="Tempo aplicado antes de abrir." />
                    <StatCard label="Comissionamento" value={lockerState.deviceConfig.commissioning?.status === 'complete' ? 'Concluido' : 'Pendente'} hint={lockerState.deviceConfig.commissioning?.completedAt ? formatDateTime(lockerState.deviceConfig.commissioning.completedAt) : 'Abra o modo tecnico para mapear.'} />
                  </div>
                  <div className="preview-shell">Ultimo frame: {lastPreview || 'Nenhum frame enviado nesta sessao.'}</div>
                </section>

                <section className="panel-card">
                  <div className="side-header">
                    <h2 className="side-title">Auditoria local</h2>
                    <span className="small-copy">{lockerState.auditTrail.length} eventos</span>
                  </div>
                  <div className="audit-list audit-list--tall">
                    {systemAudit.map((entry) => (
                      <AuditCard key={entry.id} entry={entry} />
                    ))}
                  </div>
                </section>
              </>
            ) : null}
          </aside>
          ) : null}
        </section>
      </div>
        {diagnosticGate.open ? (
          <DiagnosticsView
            lockerState={lockerState}
            onClose={diagnosticGate.close}
            onCommissioningComplete={handleCommissioningComplete}
          />
        ) : null}
        {showBannerPopup ? (
          isPublicFlowView ? (
            <KioskNoticeDialog
              tone={banner.tone}
              title={banner.title}
              text={banner.text}
              onClose={() => setDismissedBannerKey(bannerKey)}
            />
          ) : (
            <section className="alert-popup-backdrop" role="presentation">
              <div className={joinClasses('alert-popup', banner.tone ? `is-${banner.tone}` : '')} role="alertdialog" aria-modal="true" aria-labelledby="alert-popup-title">
                <div className="alert-popup-mark" aria-hidden="true">!</div>
                <div className="alert-popup-copy">
                  <p className="alert-popup-kicker">{banner.tone === 'danger' ? 'Atencao necessaria' : 'Aviso do armario'}</p>
                  <h2 id="alert-popup-title" className="alert-popup-title">{banner.title}</h2>
                  <p className="alert-popup-text">{banner.text}</p>
                </div>
                <button type="button" className="alert-popup-button" onClick={() => setDismissedBannerKey(bannerKey)}>
                  Entendi
                </button>
              </div>
            </section>
          )
        ) : null}
    </main>
  );
}
