const AUTH_SCHEME = 'PREDDITA-HMAC-V1';
const encoder = new TextEncoder();

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function getCrypto() {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle || !cryptoApi?.getRandomValues) {
    throw new Error('Criptografia HMAC nao esta disponivel neste dispositivo.');
  }
  return cryptoApi;
}

function createNonce() {
  const cryptoApi = getCrypto();
  if (typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return bytesToHex(cryptoApi.getRandomValues(new Uint8Array(16)));
}

export function normalizeDeviceRequestPath(value) {
  const rawPath = String(value ?? '').trim();
  if (!rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('#')) {
    throw new Error('Rota remota invalida para assinatura.');
  }
  const parsed = new URL(rawPath, 'https://preddita.invalid');
  return `${parsed.pathname}${parsed.search}`;
}

export function createDeviceRequestCanonical({
  method,
  path,
  lockerId,
  timestamp,
  nonce,
  contentSha256,
}) {
  return [
    AUTH_SCHEME,
    String(method || 'GET').toUpperCase(),
    normalizeDeviceRequestPath(path),
    String(lockerId ?? '').trim(),
    String(timestamp ?? '').trim(),
    String(nonce ?? '').trim(),
    String(contentSha256 ?? '').trim().toLowerCase(),
  ].join('\n');
}

async function sha256Hex(value) {
  const digest = await getCrypto().subtle.digest('SHA-256', encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function createDeviceRequestAuthHeaders({
  method = 'GET',
  path,
  lockerId,
  deviceKey,
  body = '',
  timestamp = Date.now(),
  nonce = createNonce(),
}) {
  const normalizedLockerId = String(lockerId ?? '').trim();
  const normalizedDeviceKey = String(deviceKey ?? '').trim();
  const bodyText = typeof body === 'string' ? body : body == null ? '' : JSON.stringify(body);

  if (!normalizedLockerId || !normalizedDeviceKey) {
    throw new Error('Locker e chave do dispositivo sao obrigatorios para assinar a requisicao.');
  }

  const contentSha256 = await sha256Hex(bodyText);
  const canonical = createDeviceRequestCanonical({
    method,
    path,
    lockerId: normalizedLockerId,
    timestamp,
    nonce,
    contentSha256,
  });
  const signingKey = await getCrypto().subtle.importKey(
    'raw',
    encoder.encode(normalizedDeviceKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await getCrypto().subtle.sign('HMAC', signingKey, encoder.encode(canonical));

  return {
    'x-locker-id': normalizedLockerId,
    'x-preddita-timestamp': String(timestamp),
    'x-preddita-nonce': String(nonce),
    'x-preddita-content-sha256': contentSha256,
    'x-preddita-signature': `v1=${bytesToHex(new Uint8Array(signature))}`,
  };
}

export const DEVICE_REQUEST_AUTH_SCHEME = AUTH_SCHEME;
