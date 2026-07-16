export const OPERATIONAL_SCHEMA_VERSION = 1;

const OPERATIONAL_STATE_KEYS = ['residents', 'deliveries', 'commands', 'auditTrail'];

function cleanText(value) {
  return String(value ?? '').trim();
}

function toIso(value, fallback = '') {
  const timestamp = Date.parse(cleanText(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function toInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function jsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

export function splitOperationalState(state = {}) {
  const coreState = { ...state };
  for (const key of OPERATIONAL_STATE_KEYS) delete coreState[key];
  return {
    coreState,
    operationalData: {
      residents: Array.isArray(state.residents) ? state.residents : [],
      deliveries: Array.isArray(state.deliveries) ? state.deliveries : [],
      commands: Array.isArray(state.commands) ? state.commands : [],
      auditTrail: Array.isArray(state.auditTrail) ? state.auditTrail : [],
    },
  };
}

export function buildOperationalRows(operationalData = {}) {
  const generatedAt = new Date().toISOString();
  const residents = (operationalData.residents ?? []).map((resident, sortOrder) => ({
    resident_id: cleanText(resident.id),
    apartment: cleanText(resident.apartment),
    building: cleanText(resident.building),
    floor: cleanText(resident.floor),
    phone: cleanText(resident.phone),
    email: cleanText(resident.email).toLowerCase(),
    created_at: toIso(resident.createdAt, generatedAt),
    updated_at: toIso(resident.updatedAt, generatedAt),
    sort_order: sortOrder,
  })).filter((resident) => resident.resident_id);

  const deliveries = (operationalData.deliveries ?? []).map((delivery, sortOrder) => ({
    delivery_id: cleanText(delivery.id),
    recipient_id: cleanText(delivery.recipientId),
    status: cleanText(delivery.status),
    door: toInteger(delivery.door),
    size: cleanText(delivery.size || delivery.doorSize),
    recipient_email: cleanText(delivery.recipientEmail).toLowerCase(),
    unit: cleanText(delivery.unit),
    created_at: toIso(delivery.createdAt),
    deposited_at: toIso(delivery.depositedAt),
    collected_at: toIso(delivery.collectedAt),
    expires_at: toIso(delivery.expiresAt),
    sort_order: sortOrder,
    data: jsonObject(delivery),
  })).filter((delivery) => delivery.delivery_id);

  const commands = (operationalData.commands ?? []).map((command, sortOrder) => ({
    command_id: cleanText(command.id),
    type: cleanText(command.type),
    status: cleanText(command.status),
    door: toInteger(command.door),
    execution_id: cleanText(command.executionId),
    created_at: toIso(command.createdAt),
    completed_at: toIso(command.completedAt),
    lease_expires_at: toIso(command.leaseExpiresAt),
    sort_order: sortOrder,
    data: jsonObject(command),
  })).filter((command) => command.command_id);

  const auditTrail = (operationalData.auditTrail ?? []).map((entry, sortOrder) => ({
    audit_id: cleanText(entry.id),
    kind: cleanText(entry.kind),
    message: cleanText(entry.message),
    meta: jsonObject(entry.meta),
    occurred_at: toIso(entry.at, generatedAt),
    sort_order: sortOrder,
  })).filter((entry) => entry.audit_id);

  return { residents, deliveries, commands, auditTrail };
}

export async function ensureOperationalSchema(database) {
  await database.query(`
    alter table preddita_locker_states
    add column if not exists operational_schema_version integer not null default 0
  `);
  await database.query(`
    create table if not exists preddita_residents (
      tenant_id text not null,
      locker_id text not null,
      resident_id text not null,
      apartment text not null default '',
      building text not null default '',
      floor text not null default '',
      phone text not null default '',
      email text not null default '',
      created_at timestamptz not null,
      updated_at timestamptz not null,
      sort_order integer not null default 0,
      primary key (tenant_id, locker_id, resident_id),
      foreign key (tenant_id, locker_id)
        references preddita_locker_states(tenant_id, locker_id) on delete cascade
    )
  `);
  await database.query(`
    create index if not exists idx_preddita_residents_locker_unit
    on preddita_residents (tenant_id, locker_id, building, apartment)
  `);
  await database.query(`
    create table if not exists preddita_deliveries (
      tenant_id text not null,
      locker_id text not null,
      delivery_id text not null,
      recipient_id text not null default '',
      status text not null default '',
      door integer,
      size text not null default '',
      recipient_email text not null default '',
      unit text not null default '',
      created_at timestamptz,
      deposited_at timestamptz,
      collected_at timestamptz,
      expires_at timestamptz,
      sort_order integer not null default 0,
      data jsonb not null,
      primary key (tenant_id, locker_id, delivery_id),
      foreign key (tenant_id, locker_id)
        references preddita_locker_states(tenant_id, locker_id) on delete cascade
    )
  `);
  await database.query(`
    create index if not exists idx_preddita_deliveries_locker_status
    on preddita_deliveries (tenant_id, locker_id, status, deposited_at desc)
  `);
  await database.query(`
    create index if not exists idx_preddita_deliveries_recipient
    on preddita_deliveries (tenant_id, locker_id, recipient_id, created_at desc)
  `);
  await database.query(`
    create table if not exists preddita_commands (
      tenant_id text not null,
      locker_id text not null,
      command_id text not null,
      type text not null default '',
      status text not null default '',
      door integer,
      execution_id text not null default '',
      created_at timestamptz,
      completed_at timestamptz,
      lease_expires_at timestamptz,
      sort_order integer not null default 0,
      data jsonb not null,
      primary key (tenant_id, locker_id, command_id),
      foreign key (tenant_id, locker_id)
        references preddita_locker_states(tenant_id, locker_id) on delete cascade
    )
  `);
  await database.query(`
    create index if not exists idx_preddita_commands_locker_status
    on preddita_commands (tenant_id, locker_id, status, created_at desc)
  `);
  await database.query(`
    create index if not exists idx_preddita_commands_execution
    on preddita_commands (tenant_id, locker_id, execution_id)
    where execution_id <> ''
  `);
  await database.query(`
    create table if not exists preddita_audit_events (
      tenant_id text not null,
      locker_id text not null,
      audit_id text not null,
      kind text not null default '',
      message text not null default '',
      meta jsonb not null default '{}'::jsonb,
      occurred_at timestamptz not null,
      sort_order integer not null default 0,
      primary key (tenant_id, locker_id, audit_id),
      foreign key (tenant_id, locker_id)
        references preddita_locker_states(tenant_id, locker_id) on delete cascade
    )
  `);
  await database.query(`
    create index if not exists idx_preddita_audit_events_locker_time
    on preddita_audit_events (tenant_id, locker_id, occurred_at desc)
  `);
}

async function replaceResidents(client, tenantId, lockerId, rows) {
  await client.query(
    `
      insert into preddita_residents (
        tenant_id, locker_id, resident_id, apartment, building, floor, phone,
        email, created_at, updated_at, sort_order
      )
      select $1, $2, item.resident_id, item.apartment, item.building, item.floor,
        item.phone, item.email, item.created_at::timestamptz,
        item.updated_at::timestamptz, item.sort_order
      from jsonb_to_recordset($3::jsonb) as item(
        resident_id text, apartment text, building text, floor text, phone text,
        email text, created_at text, updated_at text, sort_order integer
      )
      on conflict (tenant_id, locker_id, resident_id) do update set
        apartment = excluded.apartment,
        building = excluded.building,
        floor = excluded.floor,
        phone = excluded.phone,
        email = excluded.email,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        sort_order = excluded.sort_order
    `,
    [tenantId, lockerId, JSON.stringify(rows)]
  );
  await client.query(
    `
      delete from preddita_residents
      where tenant_id = $1 and locker_id = $2
        and not (resident_id = any($3::text[]))
    `,
    [tenantId, lockerId, rows.map((row) => row.resident_id)]
  );
}

async function replaceDeliveries(client, tenantId, lockerId, rows) {
  await client.query(
    `
      insert into preddita_deliveries (
        tenant_id, locker_id, delivery_id, recipient_id, status, door, size,
        recipient_email, unit, created_at, deposited_at, collected_at, expires_at,
        sort_order, data
      )
      select $1, $2, item.delivery_id, item.recipient_id, item.status, item.door,
        item.size, item.recipient_email, item.unit,
        nullif(item.created_at, '')::timestamptz,
        nullif(item.deposited_at, '')::timestamptz,
        nullif(item.collected_at, '')::timestamptz,
        nullif(item.expires_at, '')::timestamptz,
        item.sort_order, item.data
      from jsonb_to_recordset($3::jsonb) as item(
        delivery_id text, recipient_id text, status text, door integer, size text,
        recipient_email text, unit text, created_at text, deposited_at text,
        collected_at text, expires_at text, sort_order integer, data jsonb
      )
      on conflict (tenant_id, locker_id, delivery_id) do update set
        recipient_id = excluded.recipient_id,
        status = excluded.status,
        door = excluded.door,
        size = excluded.size,
        recipient_email = excluded.recipient_email,
        unit = excluded.unit,
        created_at = excluded.created_at,
        deposited_at = excluded.deposited_at,
        collected_at = excluded.collected_at,
        expires_at = excluded.expires_at,
        sort_order = excluded.sort_order,
        data = excluded.data
    `,
    [tenantId, lockerId, JSON.stringify(rows)]
  );
  await client.query(
    `
      delete from preddita_deliveries
      where tenant_id = $1 and locker_id = $2
        and not (delivery_id = any($3::text[]))
    `,
    [tenantId, lockerId, rows.map((row) => row.delivery_id)]
  );
}

async function replaceCommands(client, tenantId, lockerId, rows) {
  await client.query(
    `
      insert into preddita_commands (
        tenant_id, locker_id, command_id, type, status, door, execution_id,
        created_at, completed_at, lease_expires_at, sort_order, data
      )
      select $1, $2, item.command_id, item.type, item.status, item.door,
        item.execution_id, nullif(item.created_at, '')::timestamptz,
        nullif(item.completed_at, '')::timestamptz,
        nullif(item.lease_expires_at, '')::timestamptz, item.sort_order, item.data
      from jsonb_to_recordset($3::jsonb) as item(
        command_id text, type text, status text, door integer, execution_id text,
        created_at text, completed_at text, lease_expires_at text,
        sort_order integer, data jsonb
      )
      on conflict (tenant_id, locker_id, command_id) do update set
        type = excluded.type,
        status = excluded.status,
        door = excluded.door,
        execution_id = excluded.execution_id,
        created_at = excluded.created_at,
        completed_at = excluded.completed_at,
        lease_expires_at = excluded.lease_expires_at,
        sort_order = excluded.sort_order,
        data = excluded.data
    `,
    [tenantId, lockerId, JSON.stringify(rows)]
  );
  await client.query(
    `
      delete from preddita_commands
      where tenant_id = $1 and locker_id = $2
        and not (command_id = any($3::text[]))
    `,
    [tenantId, lockerId, rows.map((row) => row.command_id)]
  );
}

async function replaceAuditTrail(client, tenantId, lockerId, rows) {
  await client.query(
    `
      insert into preddita_audit_events (
        tenant_id, locker_id, audit_id, kind, message, meta, occurred_at, sort_order
      )
      select $1, $2, item.audit_id, item.kind, item.message, item.meta,
        item.occurred_at::timestamptz, item.sort_order
      from jsonb_to_recordset($3::jsonb) as item(
        audit_id text, kind text, message text, meta jsonb,
        occurred_at text, sort_order integer
      )
      on conflict (tenant_id, locker_id, audit_id) do update set
        kind = excluded.kind,
        message = excluded.message,
        meta = excluded.meta,
        occurred_at = excluded.occurred_at,
        sort_order = excluded.sort_order
    `,
    [tenantId, lockerId, JSON.stringify(rows)]
  );
  await client.query(
    `
      delete from preddita_audit_events
      where tenant_id = $1 and locker_id = $2
        and not (audit_id = any($3::text[]))
    `,
    [tenantId, lockerId, rows.map((row) => row.audit_id)]
  );
}

export async function persistOperationalState(pool, options = {}) {
  const tenantId = cleanText(options.tenantId);
  const lockerId = cleanText(options.lockerId);
  const schemaVersion = Number.parseInt(options.schemaVersion, 10) || 1;
  if (!tenantId || !lockerId) throw new Error('Tenant e locker sao obrigatorios para persistir o estado operacional.');

  const { coreState, operationalData } = splitOperationalState(options.state);
  const rows = buildOperationalRows(operationalData);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `
        insert into preddita_locker_states (
          tenant_id, locker_id, schema_version, operational_schema_version, state, updated_at
        ) values ($1, $2, $3, $4, $5::jsonb, now())
        on conflict (tenant_id, locker_id) do update set
          schema_version = excluded.schema_version,
          operational_schema_version = excluded.operational_schema_version,
          state = excluded.state,
          updated_at = now()
      `,
      [tenantId, lockerId, schemaVersion, OPERATIONAL_SCHEMA_VERSION, JSON.stringify(coreState)]
    );
    await replaceResidents(client, tenantId, lockerId, rows.residents);
    await replaceDeliveries(client, tenantId, lockerId, rows.deliveries);
    await replaceCommands(client, tenantId, lockerId, rows.commands);
    await replaceAuditTrail(client, tenantId, lockerId, rows.auditTrail);
    await client.query('commit');
    return { coreState, rowCounts: Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, value.length])) };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

function timestampToIso(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  return toIso(value);
}

export async function readOperationalState(database, options = {}) {
  const tenantId = cleanText(options.tenantId);
  const lockerId = cleanText(options.lockerId);
  const [residentResult, deliveryResult, commandResult, auditResult] = await Promise.all([
    database.query(
      `
        select resident_id, apartment, building, floor, phone, email, created_at, updated_at
        from preddita_residents
        where tenant_id = $1 and locker_id = $2
        order by sort_order, resident_id
      `,
      [tenantId, lockerId]
    ),
    database.query(
      `
        select data
        from preddita_deliveries
        where tenant_id = $1 and locker_id = $2
        order by sort_order, delivery_id
      `,
      [tenantId, lockerId]
    ),
    database.query(
      `
        select data
        from preddita_commands
        where tenant_id = $1 and locker_id = $2
        order by sort_order, command_id
      `,
      [tenantId, lockerId]
    ),
    database.query(
      `
        select audit_id, kind, message, meta, occurred_at
        from preddita_audit_events
        where tenant_id = $1 and locker_id = $2
        order by sort_order, audit_id
      `,
      [tenantId, lockerId]
    ),
  ]);

  return {
    residents: residentResult.rows.map((row) => ({
      id: row.resident_id,
      firstName: '',
      lastName: '',
      phone: row.phone,
      email: row.email,
      cpf: '',
      floor: row.floor,
      apartment: row.apartment,
      building: row.building,
      createdAt: timestampToIso(row.created_at),
      updatedAt: timestampToIso(row.updated_at),
    })),
    deliveries: deliveryResult.rows.map((row) => jsonObject(row.data)),
    commands: commandResult.rows.map((row) => jsonObject(row.data)),
    auditTrail: auditResult.rows.map((row) => {
      const meta = jsonObject(row.meta);
      return {
        id: row.audit_id,
        kind: row.kind,
        message: row.message,
        ...(Object.keys(meta).length > 0 ? { meta } : {}),
        at: timestampToIso(row.occurred_at),
      };
    }),
  };
}
