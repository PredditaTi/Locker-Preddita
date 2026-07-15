import { createHmac } from 'node:crypto';

const DEVICE_KEY = 'native-device-key-with-at-least-32-bytes';
const storage = new Map([
  ['preddita_remote_admin_device_key', 'legacy-key-that-must-be-removed'],
  ['preddita_remote_admin_working_base_url', 'https://stale-locker.example.com'],
]);
let provisioningOpened = false;
let signedInput = null;
let fetchInput = null;

globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  setTimeout,
  clearTimeout,
  PredditaDeviceAuth: {
    getConfig: () => JSON.stringify({
      available: true,
      provisioned: true,
      baseUrl: 'https://locker.example.com',
      lockerId: 'ks1062-aurora',
      signer: 'android-keystore',
      provisionedAt: 1784150000000,
    }),
    signRequest: (method, path, timestamp, nonce, contentSha256) => {
      signedInput = { method, path, timestamp, nonce, contentSha256 };
      const canonical = [
        'PREDDITA-HMAC-V1',
        method,
        path,
        'ks1062-aurora',
        timestamp,
        nonce,
        contentSha256,
      ].join('\n');
      return `v1=${createHmac('sha256', DEVICE_KEY).update(canonical).digest('hex')}`;
    },
    getLastError: () => '',
    openProvisioning: () => { provisioningOpened = true; },
  },
};

globalThis.fetch = async (url, options) => {
  fetchInput = { url, options };
  return {
    ok: true,
    json: async () => ({ ok: true }),
  };
};

const {
  getNativeDeviceAuthStatus,
  getRemoteBridgeConfig,
  openNativeDeviceProvisioning,
  publishRemoteStatus,
} = await import('../web/src/remoteBridge.js');

const status = getNativeDeviceAuthStatus();
if (!status.available || !status.provisioned || status.signer !== 'android-keystore') {
  throw new Error('Bridge deveria detectar credencial provisionada no Android Keystore.');
}
if ('deviceKey' in status) {
  throw new Error('Status nativo nunca deve expor a chave do dispositivo.');
}

const config = getRemoteBridgeConfig();
if (
  config.authMode !== 'native-hmac' ||
  config.deviceKey !== '' ||
  config.baseUrl !== 'https://locker.example.com' ||
  config.baseUrls.length !== 1 ||
  config.baseUrls[0] !== 'https://locker.example.com' ||
  config.lockerId !== 'ks1062-aurora'
) {
  throw new Error('Remote bridge deveria preferir exclusivamente a configuracao nativa.');
}
if (storage.has('preddita_remote_admin_device_key')) {
  throw new Error('Build release deveria remover chave legada do localStorage.');
}

const published = await publishRemoteStatus({
  device: { online: true, serialOpen: true },
  doors: [],
  deliveries: [],
});
if (!published || !fetchInput || !signedInput) {
  throw new Error('Status deveria ser assinado e enviado pela bridge nativa.');
}
if (fetchInput.url !== 'https://locker.example.com/api/device/status') {
  throw new Error('Credencial nativa nao deve assinar requisicao para URL legada ou de fallback.');
}
if (fetchInput.options.headers['x-device-key']) {
  throw new Error('Requisicao nativa nao deve enviar x-device-key.');
}
if (!/^v1=[a-f0-9]{64}$/.test(fetchInput.options.headers['x-preddita-signature'])) {
  throw new Error('Requisicao nativa deveria enviar assinatura HMAC v1.');
}
if (
  signedInput.method !== 'POST' ||
  signedInput.path !== '/api/device/status' ||
  signedInput.contentSha256 !== fetchInput.options.headers['x-preddita-content-sha256']
) {
  throw new Error('Android deveria assinar metodo, rota e hash enviados ao servidor.');
}
if (!openNativeDeviceProvisioning() || !provisioningOpened) {
  throw new Error('Modo diagnostico deveria abrir o provisionamento nativo.');
}

console.log('PREDDITA_V2_NATIVE_DEVICE_AUTH_OK');
