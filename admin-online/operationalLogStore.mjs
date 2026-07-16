import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

export const OPERATIONAL_LOG_SCHEMA_VERSION = 1;
export const OPERATIONAL_LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);
export const OPERATIONAL_LOG_SOURCES = Object.freeze(['server', 'admin', 'device', 'worker']);

const BLOCKED_KEY_PATTERN = /(?:authorization|cookie|csrf|password|passwd|secret|token|signature|devicekey|pin|cpf|email|phone|recovery|totp|mfa|dataurl|photo|evidence)/i;
const MAX_CONTEXT_DEPTH = 4;
const MAX_CONTEXT_KEYS = 40;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 500;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function cleanText(value, maxLength = MAX_STRING_LENGTH) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function validIso(value, fallback = '') {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function safeInteger(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function normalizeLevel(value) {
  const level = cleanText(value, 10).toLowerCase();
  return OPERATIONAL_LOG_LEVELS.includes(level) ? level : 'info';
}

function normalizeSource(value) {
  const source = cleanText(value, 20).toLowerCase();
  return OPERATIONAL_LOG_SOURCES.includes(source) ? source : 'server';
}

function normalizeActor(value) {
  const actor = cleanText(value, 120);
  const digits = actor.replace(/\D/g, '');
  const looksPersonal = actor.includes('@') || digits.length >= 10;
  if (!actor || !looksPersonal) return actor;
  const digest = createHash('sha256').update(actor.toLowerCase(), 'utf8').digest('hex').slice(0, 12);
  return `actor-${digest}`;
}

function sanitizeValue(value, depth, seen) {
  if (value === null || ['boolean', 'number'].includes(typeof value)) return value;
  if (typeof value === 'string') return cleanText(value);
  if (typeof value !== 'object' || depth >= MAX_CONTEXT_DEPTH || seen.has(value)) return undefined;

  seen.add(value);
  if (Array.isArray(value)) {
    const result = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, depth + 1, seen))
      .filter((item) => item !== undefined);
    seen.delete(value);
    return result;
  }

  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, MAX_CONTEXT_KEYS)) {
    const key = cleanText(rawKey, 80);
    if (!key || BLOCKED_KEY_PATTERN.test(key)) continue;
    const sanitized = sanitizeValue(rawValue, depth + 1, seen);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  seen.delete(value);
  return result;
}

export function sanitizeOperationalLogContext(value) {
  const sanitized = sanitizeValue(value, 0, new Set());
  return sanitized && !Array.isArray(sanitized) && typeof sanitized === 'object' ? sanitized : {};
}

export function normalizeOperationalLog(entry = {}, options = {}) {
  const occurredAt = validIso(entry.occurredAt || entry.at, new Date().toISOString());
  const statusCode = safeInteger(entry.statusCode, 100, 599);
  const durationMs = safeInteger(entry.durationMs, 0, 86_400_000);
  return {
    id: cleanText(entry.id, 120) || cleanText(options.createId?.('log'), 120),
    occurredAt,
    level: normalizeLevel(entry.level),
    event: cleanText(entry.event, 120) || 'operational-event',
    message: cleanText(entry.message, 500),
    tenantId: cleanText(entry.tenantId, 120),
    lockerId: cleanText(entry.lockerId, 120),
    requestId: cleanText(entry.requestId, 120),
    actor: normalizeActor(entry.actor),
    source: normalizeSource(entry.source),
    httpMethod: cleanText(entry.httpMethod, 12).toUpperCase(),
    httpPath: cleanText(entry.httpPath, 240).split('?')[0],
    statusCode,
    durationMs,
    context: sanitizeOperationalLogContext(entry.context),
  };
}

export function encodeOperationalLogCursor(log) {
  const occurredAt = validIso(log?.occurredAt);
  const id = cleanText(log?.id, 120);
  if (!occurredAt || !id) return '';
  return Buffer.from(JSON.stringify([occurredAt, id]), 'utf8').toString('base64url');
}

export function decodeOperationalLogCursor(value) {
  try {
    const [occurredAt, id] = JSON.parse(Buffer.from(cleanText(value, 500), 'base64url').toString('utf8'));
    const normalizedAt = validIso(occurredAt);
    const normalizedId = cleanText(id, 120);
    return normalizedAt && normalizedId ? { occurredAt: normalizedAt, id: normalizedId } : null;
  } catch (_error) {
    return null;
  }
}

export function normalizeOperationalLogFilters(filters = {}) {
  const requestedLimit = safeInteger(filters.limit, 1, MAX_LIMIT);
  const level = cleanText(filters.level, 10).toLowerCase();
  const source = cleanText(filters.source, 20).toLowerCase();
  return {
    tenantId: cleanText(filters.tenantId, 120),
    lockerId: cleanText(filters.lockerId, 120),
    level: OPERATIONAL_LOG_LEVELS.includes(level) ? level : '',
    source: OPERATIONAL_LOG_SOURCES.includes(source) ? source : '',
    event: cleanText(filters.event, 120).toLowerCase(),
    query: cleanText(filters.query || filters.q, 120).toLowerCase(),
    cursor: decodeOperationalLogCursor(filters.cursor),
    limit: requestedLimit ?? DEFAULT_LIMIT,
  };
}

function matchesFilters(log, filters) {
  if (filters.tenantId && log.tenantId !== filters.tenantId) return false;
  if (filters.lockerId && log.lockerId !== filters.lockerId) return false;
  if (filters.level && log.level !== filters.level) return false;
  if (filters.source && log.source !== filters.source) return false;
  if (filters.event && log.event.toLowerCase() !== filters.event) return false;
  if (filters.query) {
    const haystack = `${log.event} ${log.message} ${log.requestId} ${log.actor}`.toLowerCase();
    if (!haystack.includes(filters.query)) return false;
  }
  if (filters.cursor) {
    const comparison = log.occurredAt.localeCompare(filters.cursor.occurredAt);
    if (comparison > 0 || (comparison === 0 && log.id.localeCompare(filters.cursor.id) >= 0)) return false;
  }
  return true;
}

export function filterOperationalLogs(logs, rawFilters = {}) {
  const filters = normalizeOperationalLogFilters(rawFilters);
  const matching = logs
    .filter((log) => matchesFilters(log, filters))
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id));
  const page = matching.slice(0, filters.limit);
  return {
    logs: page,
    nextCursor: matching.length > filters.limit ? encodeOperationalLogCursor(page.at(-1)) : '',
  };
}

export async function ensureOperationalLogSchema(database) {
  await database.query(`
    create table if not exists preddita_operational_logs (
      log_id text primary key,
      occurred_at timestamptz not null,
      level text not null,
      event text not null,
      message text not null default '',
      tenant_id text not null default '',
      locker_id text not null default '',
      request_id text not null default '',
      actor text not null default '',
      source text not null default 'server',
      http_method text not null default '',
      http_path text not null default '',
      status_code integer,
      duration_ms integer,
      context jsonb not null default '{}'::jsonb
    )
  `);
  await database.query(`
    create index if not exists idx_preddita_operational_logs_scope_time
    on preddita_operational_logs (tenant_id, locker_id, occurred_at desc, log_id desc)
  `);
  await database.query(`
    create index if not exists idx_preddita_operational_logs_event_time
    on preddita_operational_logs (event, occurred_at desc)
  `);
  await database.query(`
    create index if not exists idx_preddita_operational_logs_level_time
    on preddita_operational_logs (level, occurred_at desc)
  `);
  await database.query(`
    create index if not exists idx_preddita_operational_logs_request
    on preddita_operational_logs (request_id)
    where request_id <> ''
  `);
}

export async function appendOperationalLog(database, rawEntry, options = {}) {
  const entry = normalizeOperationalLog(rawEntry, options);
  if (!entry.id) throw new Error('Log operacional precisa de um identificador.');
  await database.query(
    `
      insert into preddita_operational_logs (
        log_id, occurred_at, level, event, message, tenant_id, locker_id,
        request_id, actor, source, http_method, http_path, status_code,
        duration_ms, context
      ) values (
        $1, $2::timestamptz, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14, $15::jsonb
      )
      on conflict (log_id) do nothing
    `,
    [
      entry.id,
      entry.occurredAt,
      entry.level,
      entry.event,
      entry.message,
      entry.tenantId,
      entry.lockerId,
      entry.requestId,
      entry.actor,
      entry.source,
      entry.httpMethod,
      entry.httpPath,
      entry.statusCode,
      entry.durationMs,
      JSON.stringify(entry.context),
    ]
  );
  return entry;
}

function rowToOperationalLog(row) {
  return {
    id: row.log_id,
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : validIso(row.occurred_at),
    level: row.level,
    event: row.event,
    message: row.message,
    tenantId: row.tenant_id,
    lockerId: row.locker_id,
    requestId: row.request_id,
    actor: row.actor,
    source: row.source,
    httpMethod: row.http_method,
    httpPath: row.http_path,
    statusCode: row.status_code === null ? null : Number(row.status_code),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    context: row.context && typeof row.context === 'object' ? row.context : {},
  };
}

export async function queryOperationalLogs(database, rawFilters = {}) {
  const filters = normalizeOperationalLogFilters(rawFilters);
  const clauses = [];
  const values = [];
  const add = (clause, value) => {
    values.push(value);
    clauses.push(clause.replace('?', `$${values.length}`));
  };

  if (filters.tenantId) add('tenant_id = ?', filters.tenantId);
  if (filters.lockerId) add('locker_id = ?', filters.lockerId);
  if (filters.level) add('level = ?', filters.level);
  if (filters.source) add('source = ?', filters.source);
  if (filters.event) add('event = ?', filters.event);
  if (filters.query) {
    values.push(`%${filters.query}%`);
    const parameter = `$${values.length}`;
    clauses.push(`(event ilike ${parameter} or message ilike ${parameter} or request_id ilike ${parameter} or actor ilike ${parameter})`);
  }
  if (filters.cursor) {
    values.push(filters.cursor.occurredAt, filters.cursor.id);
    clauses.push(`(occurred_at, log_id) < ($${values.length - 1}::timestamptz, $${values.length})`);
  }
  values.push(filters.limit + 1);

  const result = await database.query(
    `
      select log_id, occurred_at, level, event, message, tenant_id, locker_id,
        request_id, actor, source, http_method, http_path, status_code,
        duration_ms, context
      from preddita_operational_logs
      ${clauses.length > 0 ? `where ${clauses.join(' and ')}` : ''}
      order by occurred_at desc, log_id desc
      limit $${values.length}
    `,
    values
  );
  const logs = result.rows.slice(0, filters.limit).map(rowToOperationalLog);
  return {
    logs,
    nextCursor: result.rows.length > filters.limit ? encodeOperationalLogCursor(logs.at(-1)) : '',
  };
}

export async function pruneOperationalLogs(database, retentionDays) {
  const days = safeInteger(retentionDays, 1, 3650) ?? 30;
  const result = await database.query(
    `delete from preddita_operational_logs where occurred_at < now() - ($1::integer * interval '1 day')`,
    [days]
  );
  return Number(result.rowCount || 0);
}

export function createJsonOperationalLogStore(options = {}) {
  const filePath = options.filePath;
  const maxEntries = safeInteger(options.maxEntries, 100, 100_000) ?? 5000;
  let writeQueue = Promise.resolve();

  async function readAll() {
    try {
      const content = await readFile(filePath, 'utf8');
      return content
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return normalizeOperationalLog(JSON.parse(line));
          } catch (_error) {
            return null;
          }
        })
        .filter(Boolean)
        .slice(-maxEntries);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function rewrite(logs) {
    await mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    const content = logs.map((log) => JSON.stringify(log)).join('\n');
    await writeFile(temporaryPath, content ? `${content}\n` : '', 'utf8');
    await rename(temporaryPath, filePath);
  }

  return {
    async append(rawEntry, appendOptions = {}) {
      const entry = normalizeOperationalLog(rawEntry, appendOptions);
      if (!entry.id) throw new Error('Log operacional precisa de um identificador.');
      writeQueue = writeQueue.then(async () => {
        await mkdir(dirname(filePath), { recursive: true });
        await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
      });
      await writeQueue;
      return entry;
    },
    async query(filters = {}) {
      await writeQueue;
      return filterOperationalLogs(await readAll(), filters);
    },
    async prune(retentionDays) {
      await writeQueue;
      const days = safeInteger(retentionDays, 1, 3650) ?? 30;
      const cutoff = Date.now() - days * 86_400_000;
      const logs = (await readAll()).filter((log) => Date.parse(log.occurredAt) >= cutoff).slice(-maxEntries);
      writeQueue = writeQueue.then(() => rewrite(logs));
      await writeQueue;
      return logs.length;
    },
  };
}
