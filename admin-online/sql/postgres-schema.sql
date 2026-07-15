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
