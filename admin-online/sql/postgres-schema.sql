-- PREDDITA Admin Online - schema inicial Postgres
--
-- Esta primeira etapa usa snapshots JSONB por tenant/locker. E uma migracao
-- segura a partir do state.json atual: preserva o dominio existente e separa
-- os dados por armario. A etapa seguinte pode normalizar este snapshot em
-- tabelas relacionais para moradores, portas, entregas, comandos e auditoria.

create table if not exists preddita_locker_states (
  tenant_id text not null,
  locker_id text not null,
  schema_version integer not null,
  state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, locker_id)
);

create index if not exists idx_preddita_locker_states_updated_at
  on preddita_locker_states (updated_at desc);

create index if not exists idx_preddita_locker_states_state_gin
  on preddita_locker_states using gin (state);

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
