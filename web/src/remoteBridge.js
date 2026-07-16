import { formatRecipientApartment, formatRecipientUnit } from './lockerWorkflow.js';
import {
  createDeviceRequestAuthHeaders,
  createDeviceRequestAuthPayload,
} from './deviceRequestAuth.js';

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

const IS_DEVELOPMENT = Boolean(import.meta.env?.DEV);
const BUILD_BASE_URL = String(import.meta.env?.VITE_PREDDITA_REMOTE_URL ?? '').trim();
const BUILD_DEVICE_KEY = IS_DEVELOPMENT
  ? String(import.meta.env?.VITE_PREDDITA_DEVICE_KEY ?? '').trim()
  : '';
const BUILD_LOCKER_ID = String(import.meta.env?.VITE_PREDDITA_LOCKER_ID ?? '').trim();
const BUILD_DEVICE_AUTH_MODE = String(import.meta.env?.VITE_PREDDITA_DEVICE_AUTH_MODE ?? 'hmac')
  .trim()
  .toLowerCase();
const BUILD_FALLBACK_URLS = String(import.meta.env?.VITE_PREDDITA_FALLBACK_URLS ?? '')
  .split(',')
  .map((url) => url.trim().replace(/\/$/, ''))
  .filter(Boolean);

const FALLBACK_BASE_URLS = BUILD_FALLBACK_URLS;
const DEFAULT_LOCKER_ID = BUILD_LOCKER_ID || 'ks1062-aurora';
const REQUEST_TIMEOUT_MS = 5000;
const EDGE_APP_VERSION = String(import.meta.env?.VITE_PREDDITA_EDGE_APP_VERSION ?? '2.0.19-lab').trim();

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

function removeLocalValue(key) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.removeItem(key);
  } catch (_error) {
  }
}

function getNativeDeviceAuthBridge() {
  if (typeof window === 'undefined') return null;
  const bridge = window.PredditaDeviceAuth;
  return bridge && typeof bridge.getConfig === 'function' ? bridge : null;
}

export function getNativeDeviceAuthStatus() {
  const bridge = getNativeDeviceAuthBridge();
  if (!bridge) {
    return {
      available: false,
      provisioned: false,
      baseUrl: '',
      lockerId: '',
      signer: '',
      provisionedAt: 0,
    };
  }
  try {
    const parsed = JSON.parse(String(bridge.getConfig() || '{}'));
    return {
      available: true,
      provisioned: Boolean(parsed.provisioned),
      baseUrl: String(parsed.baseUrl ?? '').trim().replace(/\/$/, ''),
      lockerId: String(parsed.lockerId ?? '').trim(),
      signer: String(parsed.signer ?? 'android-keystore').trim(),
      provisionedAt: Number(parsed.provisionedAt) || 0,
    };
  } catch (_error) {
    return {
      available: true,
      provisioned: false,
      baseUrl: '',
      lockerId: '',
      signer: 'android-keystore',
      provisionedAt: 0,
    };
  }
}

export function openNativeDeviceProvisioning() {
  const bridge = getNativeDeviceAuthBridge();
  if (!bridge || typeof bridge.openProvisioning !== 'function') return false;
  try {
    bridge.openProvisioning(BUILD_BASE_URL, BUILD_LOCKER_ID || DEFAULT_LOCKER_ID);
    return true;
  } catch (_error) {
    return false;
  }
}

async function createNativeDeviceAuthHeaders(config, method, path, body) {
  const bridge = getNativeDeviceAuthBridge();
  if (!bridge || typeof bridge.signRequest !== 'function') {
    throw new Error('Assinador Android nao esta disponivel.');
  }
  const payload = await createDeviceRequestAuthPayload({
    method,
    path,
    lockerId: config.lockerId,
    body,
  });
  const signature = String(bridge.signRequest(
    payload.method,
    payload.path,
    payload.timestamp,
    payload.nonce,
    payload.contentSha256
  ) || '').trim();
  if (!/^v1=[a-f0-9]{64}$/i.test(signature)) {
    const detail = typeof bridge.getLastError === 'function'
      ? String(bridge.getLastError() || '').trim()
      : '';
    throw new Error(detail || 'Android Keystore nao conseguiu assinar a requisicao.');
  }
  return { ...payload.headers, 'x-preddita-signature': signature.toLowerCase() };
}

function isAllowedBaseUrl(value) {
  const url = String(value ?? '').trim();
  if (/^https:\/\//i.test(url)) return true;
  return IS_DEVELOPMENT && /^http:\/\//i.test(url);
}

export function getRemoteBridgeConfig() {
  const nativeAuth = getNativeDeviceAuthStatus();
  const fallbackBaseUrl = BUILD_BASE_URL || getLocalValue(REMOTE_BASE_URL_KEY, '');
  const baseUrl = (nativeAuth.provisioned ? nativeAuth.baseUrl : fallbackBaseUrl).replace(/\/$/, '');
  const workingBaseUrl = getLocalValue(REMOTE_WORKING_BASE_URL_KEY, '').replace(/\/$/, '');
  const fallbackLockerId = BUILD_LOCKER_ID || getLocalValue(REMOTE_LOCKER_ID_KEY, DEFAULT_LOCKER_ID);
  const candidateBaseUrls = nativeAuth.provisioned
    ? [baseUrl]
    : [workingBaseUrl, baseUrl, ...FALLBACK_BASE_URLS];
  return {
    baseUrl,
    baseUrls: candidateBaseUrls
      .filter(isAllowedBaseUrl)
      .filter((item, index, items) => items.indexOf(item) === index),
    deviceKey: nativeAuth.provisioned || !IS_DEVELOPMENT
      ? ''
      : BUILD_DEVICE_KEY || getLocalValue(REMOTE_DEVICE_KEY_KEY, ''),
    lockerId: nativeAuth.provisioned ? nativeAuth.lockerId : fallbackLockerId,
    authMode: nativeAuth.provisioned
      ? 'native-hmac'
      : BUILD_DEVICE_AUTH_MODE === 'legacy' ? 'legacy' : 'hmac',
    nativeAuth,
  };
}

export function setRemoteBridgeConfig(updates = {}) {
  const nextBaseUrl = String(updates.baseUrl ?? '').trim().replace(/\/$/, '');
  const nextDeviceKey = String(updates.deviceKey ?? '').trim();
  const nextLockerId = String(updates.lockerId ?? '').trim();

  if (nextBaseUrl) setLocalValue(REMOTE_BASE_URL_KEY, nextBaseUrl);
  if (nextDeviceKey && IS_DEVELOPMENT) setLocalValue(REMOTE_DEVICE_KEY_KEY, nextDeviceKey);
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
  if (config.nativeAuth.available && !config.nativeAuth.provisioned && !IS_DEVELOPMENT) {
    throw new Error('Dispositivo ainda nao provisionado no Android Keystore.');
  }
  if (config.authMode !== 'native-hmac' && !config.deviceKey) {
    throw new Error('Chave do dispositivo nao configurada.');
  }

  for (const baseUrl of config.baseUrls) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const authHeaders = config.authMode === 'native-hmac'
        ? await createNativeDeviceAuthHeaders(
            config,
            fetchOptions.method || 'GET',
            path,
            fetchOptions.body ?? ''
          )
        : config.authMode === 'legacy'
          ? { 'x-device-key': config.deviceKey, 'x-locker-id': config.lockerId }
          : await createDeviceRequestAuthHeaders({
            method: fetchOptions.method || 'GET',
            path,
            lockerId: config.lockerId,
            deviceKey: config.deviceKey,
            body: fetchOptions.body ?? '',
          });
      const response = await fetch(`${baseUrl}${path}`, {
        ...fetchOptions,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...authHeaders,
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

if (!IS_DEVELOPMENT) {
  removeLocalValue(REMOTE_DEVICE_KEY_KEY);
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
