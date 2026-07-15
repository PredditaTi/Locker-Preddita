import { formatRecipientApartment, formatRecipientUnit } from './lockerWorkflow.js';

/*
 * Ponte HTTP entre o app embarcado no Android e o Admin Online.
 *
 * O armario precisa continuar operando mesmo quando esta sem internet. Por isso
 * este modulo nunca deve decidir estado definitivo sozinho: ele apenas tenta
 * publicar status/eventos, buscar moradores/comandos e confirmar execucoes.
 * Quem chama este modulo e responsavel por manter filas persistidas em
 * localStorage e reenviar quando a conexao voltar.
 */
const REMOTE_BASE_URL_KEY = 'preddita_remote_admin_base_url';
const REMOTE_DEVICE_KEY_KEY = 'preddita_remote_admin_device_key';
const REMOTE_LOCKER_ID_KEY = 'preddita_remote_admin_locker_id';
const REMOTE_WORKING_BASE_URL_KEY = 'preddita_remote_admin_working_base_url';

const BUILD_BASE_URL = String(import.meta.env?.VITE_PREDDITA_REMOTE_URL ?? '').trim();
const BUILD_DEVICE_KEY = String(import.meta.env?.VITE_PREDDITA_DEVICE_KEY ?? '').trim();
const BUILD_LOCKER_ID = String(import.meta.env?.VITE_PREDDITA_LOCKER_ID ?? '').trim();
const IS_DEVELOPMENT = Boolean(import.meta.env?.DEV);
const BUILD_FALLBACK_URLS = String(import.meta.env?.VITE_PREDDITA_FALLBACK_URLS ?? '')
  .split(',')
  .map((url) => url.trim().replace(/\/$/, ''))
  .filter(Boolean);

const FALLBACK_BASE_URLS = BUILD_FALLBACK_URLS;
const DEFAULT_LOCKER_ID = BUILD_LOCKER_ID || 'ks1062-aurora';
const REQUEST_TIMEOUT_MS = 5000;
const EDGE_APP_VERSION = String(import.meta.env?.VITE_PREDDITA_EDGE_APP_VERSION ?? '2.0.9-lab').trim();

function getLocalValue(key, fallback) {
  if (typeof window === 'undefined' || !window.localStorage) return fallback;
  return window.localStorage.getItem(key) || fallback;
}

function setLocalValue(key, value) {
  if (typeof window === 'undefined' || !window.localStorage || !value) return;
  try {
    window.localStorage.setItem(key, value);
  } catch (_error) {
  }
}

function isAllowedBaseUrl(value) {
  const url = String(value ?? '').trim();
  if (/^https:\/\//i.test(url)) return true;
  return IS_DEVELOPMENT && /^http:\/\//i.test(url);
}

export function getRemoteBridgeConfig() {
  const baseUrl = (BUILD_BASE_URL || getLocalValue(REMOTE_BASE_URL_KEY, '')).replace(/\/$/, '');
  const workingBaseUrl = getLocalValue(REMOTE_WORKING_BASE_URL_KEY, '').replace(/\/$/, '');
  return {
    baseUrl,
    baseUrls: [workingBaseUrl, baseUrl, ...FALLBACK_BASE_URLS]
      .filter(isAllowedBaseUrl)
      .filter((item, index, items) => items.indexOf(item) === index),
    deviceKey: BUILD_DEVICE_KEY || getLocalValue(REMOTE_DEVICE_KEY_KEY, ''),
    lockerId: BUILD_LOCKER_ID || getLocalValue(REMOTE_LOCKER_ID_KEY, DEFAULT_LOCKER_ID),
  };
}

export function setRemoteBridgeConfig(updates = {}) {
  const nextBaseUrl = String(updates.baseUrl ?? '').trim().replace(/\/$/, '');
  const nextDeviceKey = String(updates.deviceKey ?? '').trim();
  const nextLockerId = String(updates.lockerId ?? '').trim();

  if (nextBaseUrl) setLocalValue(REMOTE_BASE_URL_KEY, nextBaseUrl);
  if (nextDeviceKey) setLocalValue(REMOTE_DEVICE_KEY_KEY, nextDeviceKey);
  if (nextLockerId) setLocalValue(REMOTE_LOCKER_ID_KEY, nextLockerId);
  setLocalValue(REMOTE_WORKING_BASE_URL_KEY, '');

  return getRemoteBridgeConfig();
}

async function request(path, options = {}) {
  const config = getRemoteBridgeConfig();
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...fetchOptions } = options;
  let lastError = null;

  if (config.baseUrls.length === 0) {
    throw new Error('Admin online nao configurado com uma URL HTTPS valida.');
  }
  if (!config.deviceKey) {
    throw new Error('Chave do dispositivo nao configurada.');
  }

  for (const baseUrl of config.baseUrls) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...fetchOptions,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-device-key': config.deviceKey,
          'x-locker-id': config.lockerId,
          ...(fetchOptions.headers || {}),
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || 'Falha no admin online.');
      }
      setLocalValue(REMOTE_WORKING_BASE_URL_KEY, baseUrl);
      return payload;
    } catch (error) {
      lastError = error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  throw lastError ?? new Error('Admin online indisponivel.');
}

export async function fetchRemoteSnapshot() {
  try {
    return await request('/api/device/snapshot');
  } catch (_error) {
    return null;
  }
}

export async function publishRemoteStatus(payload) {
  const config = getRemoteBridgeConfig();
  const payloadDevice = payload.device || {};
  const edgeAppVersion =
    String(payloadDevice.edgeAppVersion || payload.edgeAppVersion || EDGE_APP_VERSION).trim() ||
    EDGE_APP_VERSION;

  try {
    await request('/api/device/status', {
      method: 'POST',
      body: JSON.stringify({
        ...payload,
        lockerId: config.lockerId,
        bridgeBaseUrl: config.baseUrls[0],
        edgeAppVersion,
        device: {
          ...payloadDevice,
          edgeAppVersion,
        },
      }),
    });
    return true;
  } catch (_error) {
    return false;
  }
}

export async function completeRemoteCommand(commandId, result) {
  try {
    return await request(`/api/device/commands/${encodeURIComponent(commandId)}/complete`, {
      method: 'POST',
      body: JSON.stringify(result),
    });
  } catch (_error) {
    return null;
  }
}

export async function acknowledgeRemoteCommand(commandId, leaseId, executionId) {
  try {
    return await request(`/api/device/commands/${encodeURIComponent(commandId)}/ack`, {
      method: 'POST',
      body: JSON.stringify({ leaseId, executionId }),
    });
  } catch (_error) {
    return null;
  }
}

export async function publishRemoteEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: true, acceptedIds: [], notifications: [] };
  }

  const config = getRemoteBridgeConfig();
  try {
    return await request('/api/device/events', {
      method: 'POST',
      timeoutMs: 20000,
      body: JSON.stringify({
        lockerId: config.lockerId,
        events,
      }),
    });
  } catch (_error) {
    return null;
  }
}

export async function notifyDeliveryStored(delivery) {
  try {
    return await request('/api/device/deliveries/notify', {
      method: 'POST',
      timeoutMs: 20000,
      body: JSON.stringify({ delivery }),
    });
  } catch (error) {
    return {
      ok: false,
      notification: {
        status: 'failed',
        error: error.message || 'Falha ao enviar e-mail.',
        requestedAt: new Date().toISOString(),
      },
    };
  }
}

export function mapRemoteResidentToRecipient(resident) {
  const floor = String(resident?.floor ?? '').trim();
  const apartment = String(resident?.apartment ?? '').trim();
  const building = String(resident?.building ?? '').trim() || 'Residencial Aurora';
  const normalized = { building, floor, apartment, unit: String(resident?.unit ?? '').trim() };
  const unit = formatRecipientUnit(normalized);

  return {
    id: String(resident?.id ?? '').trim(),
    firstName: '',
    lastName: '',
    name: formatRecipientApartment({ ...normalized, unit }),
    cpf: '',
    unit,
    floor,
    apartment,
    building,
    phone: String(resident?.phone ?? '').trim(),
    email: String(resident?.email ?? '').trim(),
  };
}
