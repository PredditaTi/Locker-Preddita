import assert from 'node:assert/strict';

import {
  DEVICE_EVENT_JOURNAL_PREFIX,
  LEGACY_DEVICE_EVENTS_STORAGE_KEY,
  getDeviceEventJournalKey,
  loadDeviceEventJournal,
  migrateLegacyDeviceEventQueue,
  removeDeviceEventJournalEvents,
  saveDeviceEventJournalEvents,
} from '../web/src/deviceEventJournal.js';

class MemoryStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
    this.failWritesFor = new Set();
  }

  get length() {
    return this.values.size;
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    if (this.failWritesFor.has(key)) throw new Error('simulated-write-failure');
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

function makeEvent(id, queuedAt, extra = {}) {
  return {
    id,
    type: 'door-opened',
    payload: { door: Number(id.replace(/\D/g, '')) || 1 },
    occurredAt: queuedAt,
    attempts: 0,
    queuedAt,
    lastAttemptAt: '',
    ...extra,
  };
}

const storage = new MemoryStorage();
const first = makeEvent('event-1', '2026-07-15T10:00:00.000Z');
const second = makeEvent('event-2', '2026-07-15T10:01:00.000Z');

const saved = saveDeviceEventJournalEvents([first, second], { storage, maxItems: 10 });
assert.equal(saved.ok, true, 'eventos validos devem ser persistidos individualmente');
assert.deepEqual(
  loadDeviceEventJournal({ storage, maxItems: 10 }).map((event) => event.id),
  ['event-1', 'event-2'],
  'reinicio deve recuperar eventos na ordem de enfileiramento'
);

storage.setItem(`${DEVICE_EVENT_JOURNAL_PREFIX}registro-corrompido`, '{json-incompleto');
assert.deepEqual(
  loadDeviceEventJournal({ storage, maxItems: 10 }).map((event) => event.id),
  ['event-1', 'event-2'],
  'um registro corrompido nao deve esconder os demais eventos'
);

saveDeviceEventJournalEvents([
  { ...first, attempts: 3, lastAttemptAt: '2026-07-15T10:02:00.000Z' },
], { storage, maxItems: 10 });
assert.equal(
  loadDeviceEventJournal({ storage, maxItems: 10 }).find((event) => event.id === first.id)?.attempts,
  3,
  'atualizacao deve substituir somente o registro do evento correspondente'
);

removeDeviceEventJournalEvents(['event-1'], { storage });
assert.deepEqual(
  loadDeviceEventJournal({ storage, maxItems: 10 }).map((event) => event.id),
  ['event-2'],
  'confirmacao do servidor deve remover somente o evento aceito'
);

const cappedStorage = new MemoryStorage();
saveDeviceEventJournalEvents([
  makeEvent('event-1', '2026-07-15T10:00:00.000Z'),
  makeEvent('event-2', '2026-07-15T10:01:00.000Z'),
  makeEvent('event-3', '2026-07-15T10:02:00.000Z'),
], { storage: cappedStorage, maxItems: 2 });
assert.deepEqual(
  loadDeviceEventJournal({ storage: cappedStorage, maxItems: 2 }).map((event) => event.id),
  ['event-2', 'event-3'],
  'limite deve podar os registros mais antigos depois de gravar os novos'
);

const legacyEvent = makeEvent('legacy-event', '2026-07-15T09:00:00.000Z');
const legacyStorage = new MemoryStorage({
  [LEGACY_DEVICE_EVENTS_STORAGE_KEY]: JSON.stringify([legacyEvent]),
});
assert.deepEqual(
  loadDeviceEventJournal({ storage: legacyStorage, maxItems: 10 }).map((event) => event.id),
  ['legacy-event'],
  'fila v1 deve migrar automaticamente para o diario v2'
);
assert.equal(
  legacyStorage.getItem(LEGACY_DEVICE_EVENTS_STORAGE_KEY),
  null,
  'fila v1 so deve ser removida depois da migracao completa'
);

const failedMigrationStorage = new MemoryStorage({
  [LEGACY_DEVICE_EVENTS_STORAGE_KEY]: JSON.stringify([legacyEvent]),
});
failedMigrationStorage.failWritesFor.add(getDeviceEventJournalKey(legacyEvent.id));
const failedMigration = migrateLegacyDeviceEventQueue({ storage: failedMigrationStorage, maxItems: 10 });
assert.equal(failedMigration.migrated, false, 'falha de gravacao deve impedir conclusao da migracao');
assert.notEqual(
  failedMigrationStorage.getItem(LEGACY_DEVICE_EVENTS_STORAGE_KEY),
  null,
  'fila antiga deve permanecer disponivel quando a migracao falhar'
);

assert.deepEqual(
  loadDeviceEventJournal({ storage, maxItems: 10 }).map((event) => event.id),
  ['event-2'],
  'evento sem confirmacao deve continuar disponivel para replay idempotente'
);

console.log('PREDDITA_V2_DEVICE_EVENT_JOURNAL_OK');
