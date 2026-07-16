import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { hashAdminPassword, verifyAdminPassword } from './adminAuth.mjs';

export const ADMIN_MFA_ROLES = new Set(['suporte', 'super_admin']);
export const ADMIN_MFA_PERIOD_SECONDS = 30;
export const ADMIN_MFA_MAX_ATTEMPTS = 5;
export const ADMIN_MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DUMMY_RECOVERY_HASH = hashAdminPassword('INVALID-RECOVERY-CODE', {
  salt: 'preddita-mfa-dummy-salt',
});

function cleanText(value) {
  return String(value ?? '').trim();
}

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual ?? ''));
  const expectedBuffer = Buffer.from(String(expected ?? ''));
  return actualBuffer.length === expectedBuffer.length
    && expectedBuffer.length > 0
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function adminRoleRequiresMfa(role) {
  return ADMIN_MFA_ROLES.has(cleanText(role));
}

export function encodeBase32(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let bits = 0;
  let accumulator = 0;
  let encoded = '';

  for (const byte of input) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += BASE32_ALPHABET[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    encoded += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  }
  return encoded;
}

export function decodeBase32(value) {
  const normalized = cleanText(value).toUpperCase().replace(/[\s=-]/g, '');
  if (!normalized || /[^A-Z2-7]/.test(normalized)) {
    throw new Error('Segredo TOTP em Base32 invalido.');
  }

  let bits = 0;
  let accumulator = 0;
  const bytes = [];
  for (const character of normalized) {
    accumulator = (accumulator << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(size = 20) {
  const normalizedSize = Math.max(20, Math.min(Number(size) || 20, 64));
  return encodeBase32(randomBytes(normalizedSize));
}

export function generateTotp(secret, options = {}) {
  const period = Math.max(15, Math.min(Number(options.period) || ADMIN_MFA_PERIOD_SECONDS, 120));
  const digits = Math.max(6, Math.min(Number(options.digits) || 6, 8));
  const timestamp = Number.isFinite(Number(options.timestamp)) ? Number(options.timestamp) : Date.now();
  const counter = options.counter === undefined
    ? Math.floor(timestamp / 1000 / period)
    : Math.max(0, Number(options.counter));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(cleanText(options.algorithm).toLowerCase() || 'sha1', decodeBase32(secret))
    .update(counterBuffer)
    .digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = (
    ((digest[offset] & 127) << 24)
    | ((digest[offset + 1] & 255) << 16)
    | ((digest[offset + 2] & 255) << 8)
    | (digest[offset + 3] & 255)
  ) >>> 0;
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

export function verifyTotp(secret, code, options = {}) {
  const normalizedCode = cleanText(code);
  const digits = Math.max(6, Math.min(Number(options.digits) || 6, 8));
  if (!new RegExp(`^\\d{${digits}}$`).test(normalizedCode)) return null;
  const period = Math.max(15, Math.min(Number(options.period) || ADMIN_MFA_PERIOD_SECONDS, 120));
  const timestamp = Number.isFinite(Number(options.timestamp)) ? Number(options.timestamp) : Date.now();
  const currentCounter = Math.floor(timestamp / 1000 / period);
  const window = Math.max(0, Math.min(Number(options.window) || 0, 1));
  const lastUsedCounter = Number.isFinite(Number(options.lastUsedCounter))
    ? Number(options.lastUsedCounter)
    : -1;

  for (let offset = -window; offset <= window; offset += 1) {
    const counter = currentCounter + offset;
    if (counter < 0 || counter <= lastUsedCounter) continue;
    const expected = generateTotp(secret, { ...options, counter, digits, period });
    if (safeEqual(normalizedCode, expected)) return { counter };
  }
  return null;
}

export function createTotpUri({ secret, username, issuer = 'PREDDITA' }) {
  const normalizedIssuer = cleanText(issuer) || 'PREDDITA';
  const normalizedUsername = cleanText(username);
  if (!normalizedUsername) throw new Error('Usuario obrigatorio para configurar TOTP.');
  const label = encodeURIComponent(`${normalizedIssuer}:${normalizedUsername}`);
  const query = new URLSearchParams({
    secret: cleanText(secret),
    issuer: normalizedIssuer,
    algorithm: 'SHA1',
    digits: '6',
    period: String(ADMIN_MFA_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

export function parseMfaEncryptionKey(value) {
  const encoded = cleanText(value);
  if (!encoded || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) return null;
  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const key = Buffer.from(normalized, 'base64');
    return key.length === 32 ? key : null;
  } catch (_error) {
    return null;
  }
}

export function encryptMfaSecret(secret, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Chave de criptografia MFA invalida.');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(cleanText(secret), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), authTag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptMfaSecret(value, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Chave de criptografia MFA invalida.');
  }
  const [version, encodedIv, encodedTag, encodedCiphertext, ...rest] = cleanText(value).split('.');
  if (version !== 'v1' || rest.length > 0 || !encodedIv || !encodedTag || !encodedCiphertext) {
    throw new Error('Segredo MFA criptografado invalido.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encodedIv, 'base64url'));
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (_error) {
    throw new Error('Nao foi possivel descriptografar o segredo MFA.');
  }
}

export function createMfaChallengeToken() {
  return randomBytes(32).toString('base64url');
}

export function hashMfaChallengeToken(token) {
  return createHash('sha256').update(String(token ?? '')).digest('hex');
}

function randomRecoverySegment(length) {
  let value = '';
  while (value.length < length) {
    const byte = randomBytes(1)[0];
    if (byte >= Math.floor(256 / RECOVERY_ALPHABET.length) * RECOVERY_ALPHABET.length) continue;
    value += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
  }
  return value;
}

export function normalizeRecoveryCode(value) {
  const compact = cleanText(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (compact.length !== 16 || /[^A-HJ-NP-Z2-9]/.test(compact)) return '';
  return compact.match(/.{4}/g).join('-');
}

export function generateRecoveryCodes(count = 10) {
  const normalizedCount = Math.max(6, Math.min(Number(count) || 10, 12));
  const records = [];
  const codes = [];
  const usedIds = new Set();
  while (codes.length < normalizedCount) {
    const compact = randomRecoverySegment(16);
    const code = compact.match(/.{4}/g).join('-');
    const id = compact.slice(0, 4);
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    codes.push(code);
    records.push({ id, passwordHash: hashAdminPassword(code) });
  }
  return { codes, records };
}

export function verifyRecoveryCode(code, records) {
  const normalized = normalizeRecoveryCode(code);
  const id = normalized.replace(/-/g, '').slice(0, 4);
  const record = Array.isArray(records)
    ? records.find((candidate) => candidate?.id === id)
    : null;
  const valid = verifyAdminPassword(normalized || 'INVALID-RECOVERY-CODE', record?.passwordHash || DUMMY_RECOVERY_HASH);
  return valid && record ? record : null;
}
