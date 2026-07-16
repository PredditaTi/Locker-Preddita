import assert from 'node:assert/strict';
import {
  adminRoleRequiresMfa,
  createTotpUri,
  decodeBase32,
  decryptMfaSecret,
  encodeBase32,
  encryptMfaSecret,
  generateRecoveryCodes,
  generateTotp,
  normalizeRecoveryCode,
  parseMfaEncryptionKey,
  verifyRecoveryCode,
  verifyTotp,
} from '../admin-online/adminMfa.mjs';

const rfcSecret = encodeBase32(Buffer.from('12345678901234567890'));
assert.equal(generateTotp(rfcSecret, { timestamp: 59_000, digits: 8 }), '94287082');
assert.deepEqual(decodeBase32(rfcSecret), Buffer.from('12345678901234567890'));

const currentTimestamp = 1_710_000_000_000;
const currentCode = generateTotp(rfcSecret, { timestamp: currentTimestamp });
const accepted = verifyTotp(rfcSecret, currentCode, { timestamp: currentTimestamp, window: 1 });
assert.ok(accepted);
assert.equal(
  verifyTotp(rfcSecret, currentCode, {
    timestamp: currentTimestamp,
    window: 1,
    lastUsedCounter: accepted.counter,
  }),
  null,
  'o mesmo TOTP nao pode ser reutilizado'
);
const priorCode = generateTotp(rfcSecret, { timestamp: currentTimestamp - 30_000 });
assert.ok(verifyTotp(rfcSecret, priorCode, { timestamp: currentTimestamp, window: 1 }));
assert.equal(verifyTotp(rfcSecret, '12345x', { timestamp: currentTimestamp }), null);

assert.equal(adminRoleRequiresMfa('super_admin'), true);
assert.equal(adminRoleRequiresMfa('suporte'), true);
assert.equal(adminRoleRequiresMfa('sindico'), false);
assert.match(createTotpUri({ secret: rfcSecret, username: 'admin@example.com' }), /^otpauth:\/\/totp\//);

const encodedKey = Buffer.alloc(32, 7).toString('base64');
const key = parseMfaEncryptionKey(encodedKey);
assert.equal(key?.length, 32);
assert.equal(parseMfaEncryptionKey(Buffer.alloc(16).toString('base64')), null);
const encrypted = encryptMfaSecret(rfcSecret, key);
assert.notEqual(encrypted.includes(rfcSecret), true);
assert.equal(decryptMfaSecret(encrypted, key), rfcSecret);
assert.throws(() => decryptMfaSecret(`${encrypted}corrompido`, key));

const recovery = generateRecoveryCodes(10);
assert.equal(recovery.codes.length, 10);
assert.equal(recovery.records.length, 10);
assert.equal(new Set(recovery.records.map((record) => record.id)).size, 10);
const recoveryCode = recovery.codes[0];
assert.equal(normalizeRecoveryCode(recoveryCode.toLowerCase().replaceAll('-', ' ')), recoveryCode);
assert.equal(verifyRecoveryCode(recoveryCode, recovery.records)?.id, recovery.records[0].id);
assert.equal(verifyRecoveryCode('AAAA-BBBB-CCCC-DDDD', recovery.records), null);
assert.equal(JSON.stringify(recovery.records).includes(recoveryCode), false);

console.log('PREDDITA_ADMIN_MFA_OK');
