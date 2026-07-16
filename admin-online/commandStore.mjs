import { randomUUID } from 'node:crypto';
import { persistOperationalStateInTransaction } from './operationalStore.mjs';

export const COMMAND_SCHEMA_VERSION = 1;
export const COMMAND_TRANSACTION_RETRY_ATTEMPTS = 3;

const ACTIVE_STATUSES = ['pending', 'leased', 'executing'];
const RETRYABLE_TRANSACTION_CODES = new Set(['40001', '40P01']);

function cleanText(value) {
  return String(value ?? '').trim();
}

function toInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function toIso(value) {
  const timestamp = Date.parse(cleanText(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function commandValues(command = {}) {
  return {
    commandId: cleanText(command.id),
    type: cleanText(command.type),
    status: cleanText(command.status),
    door: toInteger(command.door),
    leaseId: cleanText(command.leaseId),
    executionId: cleanText(command.executionId),
    deliveryAttempt: Math.max(0, toInteger(command.deliveryAttempt) ?? 0),
    createdAt: toIso(command.createdAt),
    acknowledgedAt: toIso(command.acknowledgedAt),
    completedAt: toIso(command.completedAt),
    leaseExpiresAt: toIso(command.leaseExpiresAt),
    data: jsonObject(command),
  };
}

function commandRefreshCounts(change) {
  return {
    expiredCount: change === 'expired' ? 1 : 0,
    releasedLeaseCount: change === 'lease-expired' ? 1 : 0,
  };
}

function mergeRefreshCounts(left, right) {
  return {
    expiredCount: left.expiredCount + right.expiredCount,
    releasedLeaseCount: left.releasedLeaseCount + right.releasedLeaseCount,
  };
}

function replaceStateCommand(state, command) {
  if (!state || !command) return state;
  return {
    ...state,
    commands: (state.commands ?? []).map((item) => item.id === command.id ? command : item),
  };
}

function isRetryableTransactionError(error) {
  return RETRYABLE_TRANSACTION_CODES.has(cleanText(error?.code));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTransaction(pool, operation, maxAttempts = COMMAND_TRANSACTION_RETRY_ATTEMPTS) {
  const attempts = Math.max(1, Number.parseInt(maxAttempts, 10) || COMMAND_TRANSACTION_RETRY_ATTEMPTS);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await operation(client, attempt);
      await client.query('commit');
      return { ...result, transactionAttempt: attempt };
    } catch (error) {
      try {
        await client.query('rollback');
      } catch (_rollbackError) {
      }
      if (attempt < attempts && isRetryableTransactionError(error)) {
        await delay(20 * attempt);
        continue;
      }
      throw error;
    } finally {
      client.release();
    }
  }
  throw new Error('Transacao de comando excedeu o limite de tentativas.');
}

async function lockLockerState(client, tenantId, lockerId) {
  const result = await client.query(
    `
      select 1
      from preddita_locker_states
      where tenant_id = $1 and locker_id = $2
      for update
    `,
    [tenantId, lockerId]
  );
  if (!result.rows[0]) throw new Error('Estado do locker nao existe para persistir o comando.');
}

async function insertCommand(client, tenantId, lockerId, command) {
  const value = commandValues(command);
  if (!value.commandId) throw new Error('commandId e obrigatorio.');
  await client.query(
    `
      insert into preddita_commands (
        tenant_id, locker_id, command_id, type, status, door, lease_id,
        execution_id, delivery_attempt, created_at, acknowledged_at,
        completed_at, lease_expires_at, sort_order, data
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        nullif($10, '')::timestamptz, nullif($11, '')::timestamptz,
        nullif($12, '')::timestamptz, nullif($13, '')::timestamptz,
        (select coalesce(min(sort_order), 0) - 1 from preddita_commands where tenant_id = $1 and locker_id = $2),
        $14::jsonb
      )
    `,
    [
      tenantId,
      lockerId,
      value.commandId,
      value.type,
      value.status,
      value.door,
      value.leaseId,
      value.executionId,
      value.deliveryAttempt,
      value.createdAt,
      value.acknowledgedAt,
      value.completedAt,
      value.leaseExpiresAt,
      JSON.stringify(value.data),
    ]
  );
}

async function updateCommand(client, tenantId, lockerId, command) {
  const value = commandValues(command);
  const result = await client.query(
    `
      update preddita_commands
      set type = $4,
          status = $5,
          door = $6,
          lease_id = $7,
          execution_id = $8,
          delivery_attempt = $9,
          created_at = nullif($10, '')::timestamptz,
          acknowledged_at = nullif($11, '')::timestamptz,
          completed_at = nullif($12, '')::timestamptz,
          lease_expires_at = nullif($13, '')::timestamptz,
          data = $14::jsonb,
          revision = revision + 1,
          updated_at = now()
      where tenant_id = $1 and locker_id = $2 and command_id = $3
      returning revision
    `,
    [
      tenantId,
      lockerId,
      value.commandId,
      value.type,
      value.status,
      value.door,
      value.leaseId,
      value.executionId,
      value.deliveryAttempt,
      value.createdAt,
      value.acknowledgedAt,
      value.completedAt,
      value.leaseExpiresAt,
      JSON.stringify(value.data),
    ]
  );
  if (!result.rows[0]) throw new Error('Comando desapareceu durante a transacao.');
  return Number(result.rows[0].revision);
}

export function reconcileOperationalCommand(command = {}, options = {}) {
  const status = cleanText(command.status);
  if (!ACTIVE_STATUSES.includes(status)) {
    return { command, changed: false, change: '', ...commandRefreshCounts('') };
  }

  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const at = options.at || new Date(nowMs).toISOString();
  const commandTtlMs = Math.max(1, Number.parseInt(options.commandTtlMs, 10) || 120_000);
  const createdAt = Date.parse(command.createdAt);
  if (Number.isFinite(createdAt) && nowMs - createdAt > commandTtlMs) {
    const next = {
      ...command,
      status: 'failed',
      completedAt: at,
      leaseId: '',
      leaseExpiresAt: '',
      result: {
        ok: false,
        error: command.executionId
          ? 'Comando expirou com resultado fisico desconhecido.'
          : 'Comando expirou antes de o armario iniciar a execucao.',
        expired: true,
        executionId: command.executionId || '',
      },
      timeline: [
        ...(command.timeline ?? []),
        {
          status: 'failed',
          at,
          detail: command.executionId
            ? 'Prazo total expirou depois do ACK; resultado fisico requer verificacao.'
            : 'Prazo total expirou antes do ACK do armario.',
        },
      ],
    };
    return { command: next, changed: true, change: 'expired', ...commandRefreshCounts('expired') };
  }

  if (!['leased', 'executing'].includes(status)) {
    return { command, changed: false, change: '', ...commandRefreshCounts('') };
  }
  const leaseExpiresAt = Date.parse(command.leaseExpiresAt);
  if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt > nowMs) {
    return { command, changed: false, change: '', ...commandRefreshCounts('') };
  }

  const next = {
    ...command,
    status: 'pending',
    leaseId: '',
    leasedAt: '',
    leaseExpiresAt: '',
    timeline: [
      ...(command.timeline ?? []),
      {
        status: 'lease-expired',
        at,
        detail: command.executionId
          ? 'Lease de execucao expirou; aguardando reconciliacao idempotente do armario.'
          : 'Lease de entrega expirou; comando voltou para a fila.',
      },
    ],
  };
  return { command: next, changed: true, change: 'lease-expired', ...commandRefreshCounts('lease-expired') };
}

export async function ensureCommandSchema(database) {
  await database.query(`
    alter table preddita_commands
      add column if not exists lease_id text not null default '',
      add column if not exists acknowledged_at timestamptz,
      add column if not exists delivery_attempt integer not null default 0,
      add column if not exists revision bigint not null default 0,
      add column if not exists updated_at timestamptz not null default now()
  `);
  await database.query(`
    update preddita_commands
    set lease_id = coalesce(nullif(lease_id, ''), data->>'leaseId', ''),
        execution_id = coalesce(nullif(execution_id, ''), data->>'executionId', ''),
        delivery_attempt = greatest(
          delivery_attempt,
          case when data->>'deliveryAttempt' ~ '^[0-9]+$' then (data->>'deliveryAttempt')::integer else 0 end
        ),
        updated_at = now()
  `);
  await database.query(`
    create unique index if not exists uq_preddita_commands_active_door
    on preddita_commands (tenant_id, locker_id, door)
    where status in ('pending', 'leased', 'executing')
  `);
  await database.query(`
    create unique index if not exists uq_preddita_commands_execution
    on preddita_commands (tenant_id, locker_id, execution_id)
    where execution_id <> ''
  `);
}

export async function createOperationalCommand(pool, options = {}) {
  const tenantId = cleanText(options.tenantId);
  const lockerId = cleanText(options.lockerId);
  const command = jsonObject(options.command);
  try {
    return await runTransaction(pool, async (client) => {
      await lockLockerState(client, tenantId, lockerId);
      const activeResult = await client.query(
        `
          select data
          from preddita_commands
          where tenant_id = $1 and locker_id = $2 and door = $3
            and status in ('pending', 'leased', 'executing')
          limit 1
          for update
        `,
        [tenantId, lockerId, toInteger(command.door)]
      );
      if (activeResult.rows[0]) {
        return { created: false, conflict: 'active-door', command: jsonObject(activeResult.rows[0].data) };
      }

      const currentState = options.loadState ? await options.loadState(client) : null;
      const nextState = options.buildState ? await options.buildState(currentState, command) : null;
      await insertCommand(client, tenantId, lockerId, command);
      if (nextState) {
        await persistOperationalStateInTransaction(client, {
          tenantId,
          lockerId,
          schemaVersion: options.schemaVersion,
          state: nextState,
          synchronizeCommands: false,
        });
      }
      return { created: true, command };
    }, options.maxAttempts);
  } catch (error) {
    if (cleanText(error?.code) === '23505') {
      return { created: false, conflict: 'database-unique', command: null, transactionAttempt: 1 };
    }
    throw error;
  }
}

async function processOperationalCommands(pool, options = {}, leasePending = false) {
  const tenantId = cleanText(options.tenantId);
  const lockerId = cleanText(options.lockerId);
  return runTransaction(pool, async (client) => {
    const result = await client.query(
      `
        select data
        from preddita_commands
        where tenant_id = $1 and locker_id = $2
          and status in ('pending', 'leased', 'executing')
        order by created_at, command_id
        for update skip locked
      `,
      [tenantId, lockerId]
    );
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const at = options.at || new Date(nowMs).toISOString();
    const leaseDurationMs = Math.max(1, Number.parseInt(options.leaseDurationMs, 10) || 15_000);
    let refresh = { expiredCount: 0, releasedLeaseCount: 0 };
    const leasedCommands = [];

    for (const row of result.rows) {
      const reconciled = reconcileOperationalCommand(jsonObject(row.data), {
        nowMs,
        at,
        commandTtlMs: options.commandTtlMs,
      });
      refresh = mergeRefreshCounts(refresh, reconciled);
      let next = reconciled.command;
      if (leasePending && next.status === 'pending') {
        const leasedAt = at;
        next = {
          ...next,
          status: 'leased',
          leaseId: options.leaseIdFactory?.(next) || `lease-${randomUUID()}`,
          leasedAt,
          leaseExpiresAt: new Date(nowMs + leaseDurationMs).toISOString(),
          deliveryAttempt: Math.max(0, Number.parseInt(next.deliveryAttempt, 10) || 0) + 1,
          timeline: [
            ...(next.timeline ?? []),
            {
              status: 'leased',
              at: leasedAt,
              detail: 'Comando reservado para entrega; aguardando ACK antes da execucao.',
            },
          ],
        };
        leasedCommands.push(next);
      }
      if (reconciled.changed || next !== reconciled.command) {
        await updateCommand(client, tenantId, lockerId, next);
      }
    }
    return { ...refresh, leasedCommands };
  }, options.maxAttempts);
}

export function refreshOperationalCommands(pool, options = {}) {
  return processOperationalCommands(pool, options, false);
}

export function leaseOperationalCommands(pool, options = {}) {
  return processOperationalCommands(pool, options, true);
}

export async function mutateOperationalCommand(pool, options = {}) {
  const tenantId = cleanText(options.tenantId);
  const lockerId = cleanText(options.lockerId);
  const commandId = cleanText(options.commandId);
  try {
    return await runTransaction(pool, async (client) => {
      await lockLockerState(client, tenantId, lockerId);
      const result = await client.query(
        `
          select data
          from preddita_commands
          where tenant_id = $1 and locker_id = $2 and command_id = $3
          for update
        `,
        [tenantId, lockerId, commandId]
      );
      if (!result.rows[0]) return { found: false };

      const reconciled = reconcileOperationalCommand(jsonObject(result.rows[0].data), {
        nowMs: options.nowMs,
        at: options.at,
        commandTtlMs: options.commandTtlMs,
      });
      let state = options.loadState ? await options.loadState(client) : null;
      state = replaceStateCommand(state, reconciled.command);
      const outcome = await options.mutate({
        client,
        command: reconciled.command,
        state,
        refresh: {
          expiredCount: reconciled.expiredCount,
          releasedLeaseCount: reconciled.releasedLeaseCount,
        },
      });
      const nextCommand = outcome?.command ?? (reconciled.changed ? reconciled.command : null);
      if (nextCommand) await updateCommand(client, tenantId, lockerId, nextCommand);
      if (outcome?.state) {
        await persistOperationalStateInTransaction(client, {
          tenantId,
          lockerId,
          schemaVersion: options.schemaVersion,
          state: outcome.state,
          synchronizeCommands: false,
        });
      }
      return { found: true, ...outcome };
    }, options.maxAttempts);
  } catch (error) {
    if (cleanText(error?.code) === '23505') {
      return { found: true, conflict: 'execution-id', transactionAttempt: 1 };
    }
    throw error;
  }
}
