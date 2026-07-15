const STORAGE_KEY = 'preddita_remote_command_executions_v1';
const MAX_RECORDS = 80;

function cleanText(value) {
  return String(value ?? '').trim();
}

function getDefaultStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch (_error) {
    return null;
  }
}

export function normalizeRemoteCommandExecution(value) {
  if (!value || typeof value !== 'object') return null;
  const commandId = cleanText(value.commandId);
  const executionId = cleanText(value.executionId);
  if (!commandId || !executionId) return null;

  return {
    commandId,
    executionId,
    leaseId: cleanText(value.leaseId),
    status: ['received', 'executing', 'completed', 'unknown'].includes(value.status)
      ? value.status
      : 'received',
    door: Number.parseInt(value.door, 10),
    deliveryAttempt: Math.max(0, Number.parseInt(value.deliveryAttempt, 10) || 0),
    result: value.result && typeof value.result === 'object' ? value.result : null,
    receivedAt: cleanText(value.receivedAt),
    executingAt: cleanText(value.executingAt),
    completedAt: cleanText(value.completedAt),
    updatedAt: cleanText(value.updatedAt),
  };
}

export function loadRemoteCommandExecutions(storage = getDefaultStorage()) {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeRemoteCommandExecution).filter(Boolean).slice(-MAX_RECORDS);
  } catch (_error) {
    return [];
  }
}

export function saveRemoteCommandExecutions(records, storage = getDefaultStorage()) {
  const normalized = (Array.isArray(records) ? records : [])
    .map(normalizeRemoteCommandExecution)
    .filter(Boolean)
    .slice(-MAX_RECORDS);
  if (!storage) return normalized;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch (_error) {
  }
  return normalized;
}

export function createRemoteExecutionId(commandId) {
  const safeCommandId = cleanText(commandId) || 'command';
  const randomId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `exec-${safeCommandId}-${randomId}`;
}

export function upsertRemoteCommandExecution(records, command, at = new Date().toISOString()) {
  const commandId = cleanText(command?.id);
  if (!commandId) throw new Error('Comando remoto sem id.');

  const previous = (Array.isArray(records) ? records : []).find((item) => item.commandId === commandId);
  const serverExecutionId = cleanText(command?.executionId);
  const conflict = Boolean(previous && serverExecutionId && previous.executionId !== serverExecutionId);
  const executionId = conflict
    ? serverExecutionId
    : previous?.executionId || serverExecutionId || createRemoteExecutionId(commandId);
  const execution = normalizeRemoteCommandExecution({
    ...previous,
    commandId,
    executionId,
    leaseId: command?.leaseId,
    status: conflict ? 'unknown' : previous?.status || (serverExecutionId ? 'unknown' : 'received'),
    door: command?.door,
    deliveryAttempt: command?.deliveryAttempt,
    receivedAt: previous?.receivedAt || at,
    updatedAt: at,
  });
  const nextRecords = [
    ...(Array.isArray(records) ? records : []).filter((item) => item.commandId !== commandId),
    execution,
  ].slice(-MAX_RECORDS);

  return { records: nextRecords, execution, conflict, created: !previous };
}

export function updateRemoteCommandExecution(records, commandId, updates, at = new Date().toISOString()) {
  const normalizedCommandId = cleanText(commandId);
  let updated = null;
  const nextRecords = (Array.isArray(records) ? records : []).map((item) => {
    if (item.commandId !== normalizedCommandId) return item;
    updated = normalizeRemoteCommandExecution({ ...item, ...updates, updatedAt: at });
    return updated;
  });
  return { records: nextRecords.slice(-MAX_RECORDS), execution: updated };
}

export const REMOTE_COMMAND_EXECUTIONS_STORAGE_KEY = STORAGE_KEY;
