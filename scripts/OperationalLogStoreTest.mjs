import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPERATIONAL_LOG_LEVELS,
  OPERATIONAL_LOG_SCHEMA_VERSION,
  appendOperationalLog,
  createJsonOperationalLogStore,
  decodeOperationalLogCursor,
  filterOperationalLogs,
  normalizeOperationalLog,
  sanitizeOperationalLogContext,
} from '../admin-online/operationalLogStore.mjs';

assert.equal(OPERATIONAL_LOG_SCHEMA_VERSION, 1);
assert.deepEqual(OPERATIONAL_LOG_LEVELS, ['debug', 'info', 'warn', 'error']);

const circular = { safe: 'visible' };
circular.self = circular;
const sanitized = sanitizeOperationalLogContext({
  password: 'never-store-me',
  authToken: 'never-store-me-either',
  delivery: {
    email: 'resident@example.com',
    phone: '47999999999',
    door: 7,
    status: 'stored',
  },
  circular,
  longValue: 'x'.repeat(700),
});
assert.deepEqual(sanitized.delivery, { door: 7, status: 'stored' });
assert.deepEqual(sanitized.circular, { safe: 'visible' });
assert.equal(sanitized.longValue.length, 500);
assert.equal(JSON.stringify(sanitized).includes('never-store-me'), false);
assert.equal(JSON.stringify(sanitized).includes('resident@example.com'), false);

let nextId = 0;
const normalized = normalizeOperationalLog({
  at: '2026-07-15T12:00:00.000Z',
  level: 'ERROR',
  event: 'api-request-failed',
  httpMethod: 'post',
  httpPath: '/api/device/status?token=secret',
  statusCode: 500,
  durationMs: 42,
  context: { deviceKey: 'hidden', errorCode: 'ECONNRESET' },
}, { createId: () => `log-${++nextId}` });
assert.equal(normalized.id, 'log-1');
assert.equal(normalized.level, 'error');
assert.equal(normalized.httpMethod, 'POST');
assert.equal(normalized.httpPath, '/api/device/status');
assert.deepEqual(normalized.context, { errorCode: 'ECONNRESET' });
const personalActor = normalizeOperationalLog({ id: 'actor-log', actor: 'admin@example.com' });
assert.match(personalActor.actor, /^actor-[a-f0-9]{12}$/);
assert.equal(personalActor.actor.includes('example.com'), false);

const insertedQueries = [];
const insertedLog = await appendOperationalLog({
  async query(sql, values) {
    insertedQueries.push({ sql, values });
    return { rowCount: 1 };
  },
}, { ...normalized, id: 'inserted-log', lockerId: 'locker-insert' });
assert.equal(insertedLog.id, 'inserted-log');
assert.equal(insertedQueries.length, 1);
assert.equal(insertedQueries[0].values.length, 15);
assert.equal(insertedQueries[0].values[6], 'locker-insert');
assert.equal(insertedQueries[0].values[7], normalized.requestId);

const logs = [
  normalizeOperationalLog({ ...normalized, id: 'log-c', occurredAt: '2026-07-15T12:02:00.000Z', level: 'warn' }),
  normalizeOperationalLog({ ...normalized, id: 'log-b', occurredAt: '2026-07-15T12:01:00.000Z', event: 'admin-login' }),
  normalizeOperationalLog({ ...normalized, id: 'log-a', occurredAt: '2026-07-15T12:00:00.000Z', level: 'info' }),
];
const firstPage = filterOperationalLogs(logs, { limit: 2 });
assert.deepEqual(firstPage.logs.map((log) => log.id), ['log-c', 'log-b']);
assert.ok(firstPage.nextCursor);
assert.deepEqual(decodeOperationalLogCursor(firstPage.nextCursor), {
  occurredAt: '2026-07-15T12:01:00.000Z',
  id: 'log-b',
});
const secondPage = filterOperationalLogs(logs, { cursor: firstPage.nextCursor, limit: 2 });
assert.deepEqual(secondPage.logs.map((log) => log.id), ['log-a']);
assert.equal(secondPage.nextCursor, '');
assert.deepEqual(filterOperationalLogs(logs, { event: 'ADMIN-LOGIN' }).logs.map((log) => log.id), ['log-b']);
assert.deepEqual(filterOperationalLogs(logs, { level: 'info' }).logs.map((log) => log.id), ['log-a']);

const dataDirectory = mkdtempSync(join(tmpdir(), 'preddita-operational-logs-'));
const filePath = join(dataDirectory, 'logs.jsonl');
const jsonStore = createJsonOperationalLogStore({ filePath, maxEntries: 100 });
try {
  await jsonStore.append({
    id: 'old-log',
    occurredAt: '2020-01-01T00:00:00.000Z',
    event: 'old-event',
    context: { password: 'must-not-reach-disk' },
  });
  await jsonStore.append({
    id: 'current-log',
    occurredAt: new Date().toISOString(),
    event: 'current-event',
    lockerId: 'locker-test',
  });
  const storedPage = await jsonStore.query({ lockerId: 'locker-test' });
  assert.deepEqual(storedPage.logs.map((log) => log.id), ['current-log']);
  assert.equal(readFileSync(filePath, 'utf8').includes('must-not-reach-disk'), false);
  await jsonStore.prune(30);
  const retainedPage = await jsonStore.query({});
  assert.deepEqual(retainedPage.logs.map((log) => log.id), ['current-log']);
} finally {
  rmSync(dataDirectory, { recursive: true, force: true });
}

console.log('OPERATIONAL_LOG_STORE_TEST_OK');
