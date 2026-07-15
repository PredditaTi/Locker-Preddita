const DEFAULT_MAX_ITEMS = 160;

export const LEGACY_DEVICE_EVENTS_STORAGE_KEY = 'preddita_pending_device_events_v1';
export const DEVICE_EVENT_JOURNAL_PREFIX = 'preddita_device_event_journal_v2:';

function cleanText(value) {
  return String(value ?? '').trim();
}

function resolveStorage(storage) {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage || null;
  } catch (_error) {
    return null;
  }
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ITEMS;
}

export function normalizeDeviceJournalEvent(item) {
  if (!item || typeof item !== 'object') return null;

  const id = cleanText(item.id);
  const type = cleanText(item.type);
  if (!id || !type) return null;

  return {
    id,
    type,
    payload: item.payload && typeof item.payload === 'object' ? item.payload : {},
    occurredAt: cleanText(item.occurredAt ?? item.at) || new Date().toISOString(),
    attempts: Number.isFinite(Number(item.attempts)) ? Math.max(0, Number(item.attempts)) : 0,
    queuedAt: cleanText(item.queuedAt) || new Date().toISOString(),
    lastAttemptAt: cleanText(item.lastAttemptAt),
  };
}

export function getDeviceEventJournalKey(eventId) {
  const safeId = cleanText(eventId);
  return safeId ? `${DEVICE_EVENT_JOURNAL_PREFIX}${encodeURIComponent(safeId)}` : '';
}

function compareEvents(left, right) {
  const leftTime = Date.parse(left.queuedAt);
  const rightTime = Date.parse(right.queuedAt);
  const safeLeftTime = Number.isFinite(leftTime) ? leftTime : 0;
  const safeRightTime = Number.isFinite(rightTime) ? rightTime : 0;

  if (safeLeftTime !== safeRightTime) return safeLeftTime - safeRightTime;
  return left.id.localeCompare(right.id);
}

function readJournalRecords(storage) {
  if (!storage) return [];

  const records = [];
  let storageLength = 0;
  try {
    storageLength = storage.length;
  } catch (_error) {
    return records;
  }

  for (let index = 0; index < storageLength; index += 1) {
    let key = '';
    try {
      key = storage.key(index) || '';
    } catch (_error) {
      continue;
    }
    if (!key.startsWith(DEVICE_EVENT_JOURNAL_PREFIX)) continue;

    try {
      const envelope = JSON.parse(storage.getItem(key) || 'null');
      const event = normalizeDeviceJournalEvent(envelope?.event ?? envelope);
      if (!event || getDeviceEventJournalKey(event.id) !== key) continue;
      records.push(event);
    } catch (_error) {
      // A malformed record is isolated; other events remain recoverable.
    }
  }

  return records.sort(compareEvents);
}

function writeJournalRecord(storage, event) {
  const normalized = normalizeDeviceJournalEvent(event);
  const key = getDeviceEventJournalKey(normalized?.id);
  if (!storage || !normalized || !key) return null;

  storage.setItem(key, JSON.stringify({
    version: 2,
    savedAt: new Date().toISOString(),
    event: normalized,
  }));
  return normalized;
}

function pruneJournal(storage, maxItems) {
  const records = readJournalRecords(storage);
  const overflow = Math.max(0, records.length - normalizeLimit(maxItems));
  const removedIds = [];

  for (const event of records.slice(0, overflow)) {
    try {
      storage.removeItem(getDeviceEventJournalKey(event.id));
      removedIds.push(event.id);
    } catch (_error) {
    }
  }

  return {
    events: readJournalRecords(storage),
    removedIds,
  };
}

export function migrateLegacyDeviceEventQueue(options = {}) {
  const storage = resolveStorage(options.storage);
  if (!storage) return { migrated: false, migratedIds: [], failedIds: [] };

  let raw = null;
  try {
    raw = storage.getItem(LEGACY_DEVICE_EVENTS_STORAGE_KEY);
  } catch (_error) {
    return { migrated: false, migratedIds: [], failedIds: [] };
  }
  if (raw === null) return { migrated: false, migratedIds: [], failedIds: [] };

  let legacyEvents = [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return { migrated: false, migratedIds: [], failedIds: [] };
    }
    legacyEvents = parsed.map(normalizeDeviceJournalEvent).filter(Boolean);
  } catch (_error) {
    return { migrated: false, migratedIds: [], failedIds: [] };
  }

  const migratedIds = [];
  const failedIds = [];
  for (const event of legacyEvents) {
    try {
      writeJournalRecord(storage, event);
      migratedIds.push(event.id);
    } catch (_error) {
      failedIds.push(event.id);
    }
  }

  if (failedIds.length === 0) {
    try {
      storage.removeItem(LEGACY_DEVICE_EVENTS_STORAGE_KEY);
    } catch (_error) {
      return { migrated: false, migratedIds, failedIds };
    }
    pruneJournal(storage, options.maxItems);
    return { migrated: true, migratedIds, failedIds };
  }

  return { migrated: false, migratedIds, failedIds };
}

export function loadDeviceEventJournal(options = {}) {
  const storage = resolveStorage(options.storage);
  if (!storage) return [];

  migrateLegacyDeviceEventQueue({ storage, maxItems: options.maxItems });
  return pruneJournal(storage, options.maxItems).events;
}

export function saveDeviceEventJournalEvents(events, options = {}) {
  const storage = resolveStorage(options.storage);
  const safeEvents = Array.isArray(events)
    ? events.map(normalizeDeviceJournalEvent).filter(Boolean)
    : [];
  if (!storage) {
    return { ok: false, events: [], savedIds: [], failedIds: safeEvents.map((event) => event.id) };
  }

  const savedIds = [];
  const failedIds = [];
  for (const event of safeEvents) {
    try {
      writeJournalRecord(storage, event);
      savedIds.push(event.id);
    } catch (_error) {
      failedIds.push(event.id);
    }
  }

  const journal = pruneJournal(storage, options.maxItems);
  return {
    ok: failedIds.length === 0,
    events: journal.events,
    savedIds,
    failedIds,
    prunedIds: journal.removedIds,
  };
}

export function removeDeviceEventJournalEvents(eventIds, options = {}) {
  const storage = resolveStorage(options.storage);
  const safeIds = [...new Set((Array.isArray(eventIds) ? eventIds : []).map(cleanText).filter(Boolean))];
  if (!storage) return { ok: false, removedIds: [], failedIds: safeIds };

  const removedIds = [];
  const failedIds = [];
  for (const id of safeIds) {
    try {
      storage.removeItem(getDeviceEventJournalKey(id));
      removedIds.push(id);
    } catch (_error) {
      failedIds.push(id);
    }
  }

  return { ok: failedIds.length === 0, removedIds, failedIds };
}
