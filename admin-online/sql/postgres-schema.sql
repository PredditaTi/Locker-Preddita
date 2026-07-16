-- PREDDITA Admin Online - schema inicial Postgres
--
-- O snapshot guarda configuracao, portas, dispositivo e filas auxiliares.
-- Moradores, entregas, comandos e auditoria usam tabelas por entidade.

create table if not exists preddita_locker_states (
  tenant_id text not null,
  locker_id text not null,
  schema_version integer not null,
  operational_schema_version integer not null default 0,
  state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, locker_id)
);

create index if not exists idx_preddita_locker_states_updated_at
  on preddita_locker_states (updated_at desc);

create index if not exists idx_preddita_locker_states_state_gin
  on preddita_locker_states using gin (state);

alter table preddita_locker_states
  add column if not exists operational_schema_version integer not null default 0;

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
);

create index if not exists idx_preddita_residents_locker_unit
  on preddita_residents (tenant_id, locker_id, building, apartment);

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
);

create index if not exists idx_preddita_deliveries_locker_status
  on preddita_deliveries (tenant_id, locker_id, status, deposited_at desc);

create index if not exists idx_preddita_deliveries_recipient
  on preddita_deliveries (tenant_id, locker_id, recipient_id, created_at desc);

create table if not exists preddita_commands (
  tenant_id text not null,
  locker_id text not null,
  command_id text not null,
  type text not null default '',
  status text not null default '',
  door integer,
  lease_id text not null default '',
  execution_id text not null default '',
  delivery_attempt integer not null default 0,
  created_at timestamptz,
  acknowledged_at timestamptz,
  completed_at timestamptz,
  lease_expires_at timestamptz,
  sort_order integer not null default 0,
  data jsonb not null,
  revision bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, locker_id, command_id),
  foreign key (tenant_id, locker_id)
    references preddita_locker_states(tenant_id, locker_id) on delete cascade
);

alter table preddita_commands
  add column if not exists lease_id text not null default '',
  add column if not exists acknowledged_at timestamptz,
  add column if not exists delivery_attempt integer not null default 0,
  add column if not exists revision bigint not null default 0,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_preddita_commands_locker_status
  on preddita_commands (tenant_id, locker_id, status, created_at desc);

create index if not exists idx_preddita_commands_execution
  on preddita_commands (tenant_id, locker_id, execution_id)
  where execution_id <> '';

create unique index if not exists uq_preddita_commands_active_door
  on preddita_commands (tenant_id, locker_id, door)
  where status in ('pending', 'leased', 'executing');

create unique index if not exists uq_preddita_commands_execution
  on preddita_commands (tenant_id, locker_id, execution_id)
  where execution_id <> '';

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
);

create index if not exists idx_preddita_audit_events_locker_time
  on preddita_audit_events (tenant_id, locker_id, occurred_at desc);

create table if not exists preddita_admin_users (
  username text primary key,
  user_id text not null,
  name text not null,
  role text not null,
  password_hash text not null,
  tenant_id text not null,
  locker_ids jsonb not null,
  disabled boolean not null default false,
  source text not null default 'environment',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_preddita_admin_users_tenant
  on preddita_admin_users (tenant_id, disabled, role);

create table if not exists preddita_admin_sessions (
  token_hash char(64) primary key,
  session_id text not null unique,
  username text not null references preddita_admin_users(username),
  csrf_token text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists idx_preddita_admin_sessions_active
  on preddita_admin_sessions (username, expires_at desc)
  where revoked_at is null;

create table if not exists preddita_admin_mfa (
  username text primary key references preddita_admin_users(username),
  secret_ciphertext text not null,
  last_used_step bigint not null default -1,
  recovery_codes jsonb not null default '[]'::jsonb,
  enabled_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists preddita_admin_mfa_challenges (
  token_hash char(64) primary key,
  username text not null references preddita_admin_users(username),
  kind text not null check (kind in ('enroll', 'verify')),
  pending_secret_ciphertext text,
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index if not exists idx_preddita_admin_mfa_challenges_active
  on preddita_admin_mfa_challenges (username, expires_at desc)
  where consumed_at is null;
