# PREDDITA Admin Online em servidor

Este painel pode rodar em qualquer servidor Node/Docker com HTTPS publico.

## Variaveis obrigatorias

```text
PORT=8787
PREDDITA_DATA_DIR=/data
PREDDITA_STORAGE=postgres
PREDDITA_TENANT_ID=residencial-aurora
PREDDITA_DATABASE_URL=postgresql://preddita:troque-esta-senha@postgres:5432/preddita_locker
PREDDITA_SUPER_ADMIN_TOKEN=crie-um-token-forte-para-a-preddita
PREDDITA_ADMIN_TOKEN=crie-um-token-forte-para-o-sindico
PREDDITA_DEVICE_KEY=crie-uma-chave-forte-para-o-armario
PREDDITA_DEVICE_KEYS={"ks1062-aurora":"crie-uma-chave-forte-para-o-armario"}
PREDDITA_LOCKER_ID=ks1062-aurora
PREDDITA_COMMAND_TTL_MS=120000
PREDDITA_COMMAND_LEASE_MS=15000
PREDDITA_COMMAND_EXECUTION_LEASE_MS=30000
PREDDITA_SMTP_HOST=smtp.seu-provedor.com
PREDDITA_SMTP_PORT=587
PREDDITA_SMTP_SECURE=false
PREDDITA_SMTP_USER=usuario-smtp@seudominio.com
PREDDITA_SMTP_PASS=senha-ou-app-password
PREDDITA_SMTP_FROM="PREDDITA Locker <usuario-smtp@seudominio.com>"
```

Guarde `PREDDITA_SUPER_ADMIN_TOKEN` para o Admin Geral PREDDITA e `PREDDITA_ADMIN_TOKEN` para o painel do sindico. Compile o APK do armario com a mesma chave configurada em `PREDDITA_DEVICE_KEYS`.
As variaveis `PREDDITA_SMTP_*` sao usadas para enviar o PIN e o QR Code por e-mail quando uma entrega e confirmada no armario.

`PREDDITA_DEVICE_KEY` ainda existe como compatibilidade do piloto. Para varios armarios, prefira `PREDDITA_DEVICE_KEYS`, no formato JSON:

```text
PREDDITA_DEVICE_KEYS={"ks1062-aurora":"chave-1","ks1062-torre-b":"chave-2"}
```

## Deploy com Docker em VPS

1. Copie esta pasta `admin-online` para o servidor.
2. Crie um arquivo `.env` baseado no `.env.example`.
3. Rode:

```bash
docker compose up -d --build
```

4. Configure um proxy HTTPS, como Nginx/Caddy/Traefik, apontando seu dominio para a porta `8787`.

## Deploy com Docker + HTTPS automatico

Se o dominio/subdominio ja apontar para a VPS, use o compose de producao com Caddy:

1. Crie o DNS `A` do subdominio, por exemplo `locker.preddita.com`, apontando para o IP da VPS.
2. Copie `.env.production.example` para `.env`.
3. Preencha `PREDDITA_DOMAIN`, `PREDDITA_SUPER_ADMIN_TOKEN`, `PREDDITA_ADMIN_TOKEN`, `PREDDITA_DEVICE_KEY` e `PREDDITA_SMTP_*`.
4. Rode:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

O Caddy abre as portas `80` e `443`, gera o certificado HTTPS automaticamente e encaminha o trafego para o servidor Node.

## Migrar dados atuais

O banco local fica em:

```text
admin-online/data/state.json
```

No modo local/laboratorio (`PREDDITA_STORAGE=json`), o banco fica em:

Em VPS com Docker Compose sem Postgres, o destino final precisa ser:

```text
/data/state.json
```

No modo recomendado de producao (`PREDDITA_STORAGE=postgres`), o servidor cria a tabela `preddita_locker_states` automaticamente e separa os snapshots por `tenant_id` e `locker_id`. Se existir `/data/state.json` no primeiro boot do locker padrao, ele e usado como origem inicial para preencher o Postgres.

Schema de referencia:

```text
admin-online/sql/postgres-schema.sql
```

Para validar Postgres manualmente, configure `PREDDITA_TEST_DATABASE_URL` e rode:

```powershell
node ..\scripts\v2-postgres-smoke-test.mjs
```

## Compilar APK apontando para o servidor

No computador de build:

```powershell
powershell -ExecutionPolicy Bypass -File ..\scripts\build-online-release.ps1 `
  -ServerUrl "https://seu-dominio.com" `
  -DeviceKey "a-chave-desse-armario"
```

Depois instale o APK gerado no armario. A partir disso, o app busca moradores, envia status e recebe comandos pelo servidor online.

## Observacoes importantes

- Use HTTPS, nao HTTP, para evitar bloqueios e proteger tokens.
- Em producao, use `PREDDITA_STORAGE=postgres`; o volume `/data` fica apenas como fallback/importacao inicial.
- Cada armario deve ter `lockerId` e chave propria.
- O armario precisa ter acesso a internet.
- O computador local e o `adb reverse` deixam de ser necessarios para operacao remota, mas ainda podem ser usados para instalar APKs.
