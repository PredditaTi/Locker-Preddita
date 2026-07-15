# PREDDITA Admin Online 2.0 Lab

Painel web do sindico para acompanhar o locker, cadastrar moradores e enviar comandos remotos para abertura de portas.

Esta pasta pertence a copia experimental `preddita-entregas-retiradas-v2` e nao altera o servidor que esta rodando em producao.

Para entender o desenho completo entre armario, Admin Online, eventos offline e
comandos remotos, veja `../docs/ARCHITECTURE.md`. Para comandos de setup,
build e teste, veja `../docs/DEVELOPER-RUNBOOK.md`.

## Rodar localmente

```powershell
cd "C:\Users\Usuario\Documents\App armário preddita\preddita-entregas-retiradas-v2\admin-online"
node server.mjs
```

Depois acesse:

```text
http://localhost:8787
```

Token inicial do painel:

```text
preddita-admin-local
```

Chave inicial do dispositivo:

```text
preddita-device-local
```

Em producao, troque esses valores por variaveis de ambiente:

```powershell
$env:PREDDITA_ADMIN_TOKEN="um-token-forte"
$env:PREDDITA_DEVICE_KEY="uma-chave-do-armario"
$env:PREDDITA_DEVICE_AUTH_MODE="hmac"
node server.mjs
```

## Persistencia

O servidor agora tem dois modos:

- `PREDDITA_STORAGE=json`: modo local/laboratorio, usa `admin-online/data/state.json`.
- `PREDDITA_STORAGE=postgres`: modo recomendado para producao, usa a tabela
  `preddita_locker_states` com chave primaria `tenant_id + locker_id`.

Exemplo Postgres:

```powershell
$env:PREDDITA_STORAGE="postgres"
$env:PREDDITA_DATABASE_URL="postgresql://preddita:senha@localhost:5432/preddita_locker"
$env:PREDDITA_TENANT_ID="residencial-aurora"
$env:PREDDITA_LOCKER_ID="ks1062-aurora"
$env:PREDDITA_DEVICE_KEYS='{"ks1062-aurora":"uma-chave-do-armario"}'
$env:PREDDITA_DEVICE_AUTH_MODE="hmac"
node server.mjs
```

O schema de referencia fica em `sql/postgres-schema.sql`. O servidor tambem cria
a tabela automaticamente no startup quando usa Postgres.

## Teste local da v2

Na raiz da copia v2:

```powershell
cd "C:\Users\Usuario\Documents\App armário preddita\preddita-entregas-retiradas-v2"
powershell -ExecutionPolicy Bypass -File scripts\v2-verify.ps1
```

Esse comando roda regra de negocio do kiosk, smoke test do admin, checagem de sintaxe, auditoria de dependencias e build do app do armario.
Se `PREDDITA_TEST_DATABASE_URL` estiver configurado, ele tambem valida o smoke
Postgres; caso contrario, esse teste e pulado.

Se quiser rodar apenas o smoke do servidor admin:

```powershell
node scripts\v2-smoke-test.mjs
```

O smoke sobe o servidor em uma porta temporaria, usa dados temporarios e valida:

- token de administrador obrigatorio;
- HMAC de dispositivo valido, com recusa de chave estatica, corpo adulterado,
  timestamp vencido e nonce repetido;
- cadastro de morador;
- exportacao CSV;
- heartbeat do armario;
- recusa de abertura remota quando o armario esta offline;
- criacao de comando remoto;
- entrega com lease e reentrega apos perda de resposta;
- recusa de ACK antigo ou de outro `executionId`;
- recusa de conclusao de comando inexistente;
- ACK e conclusao idempotentes com `confirmed: true`;
- resumo runtime da versao 2.0.

Resultado esperado:

```text
PREDDITA_V2_SMOKE_OK
```

## Melhorias da v2 local

- Escrita atomica de `state.json` com backup em `data/backups`.
- `runtime` no `/api/admin/state` com saude do armario, fila, SMTP e versao.
- Comparacao de tokens com `timingSafeEqual`.
- Rate limit administrativo e de abertura remota.
- Endpoint `GET /api/admin/commands/:id` para acompanhar comandos.
- Timeline de comando remoto: criado, entregue ao armario e concluido/falhou.
- UI do admin com painel de saude e rastreador de comando remoto.
- Botoes de abertura bloqueados quando o armario esta sem sinal/serial.
- API tambem bloqueia abertura remota se o armario estiver offline, stale, sem serial ou ja tiver comando pendente para a mesma porta.
- Painel exibe avisos se token/chave padrao ou CORS permissivo forem usados.
- Dependencias auditadas com `npm audit --omit=dev`.
- Persistencia opcional em Postgres por `tenant_id`/`locker_id`, mantendo
  `state.json` como modo local.
- Chave por armario via `PREDDITA_DEVICE_KEYS`.
- Requisicoes do armario assinadas com HMAC-SHA256, timestamp, nonce e hash do
  corpo; producao recusa autenticacao legada.
- Comandos remotos com `pending -> leased -> executing -> completed/failed`,
  lease renovavel e `executionId` idempotente.

## Rodar localmente com o armario via ADB

Quando o roteador bloqueia conexoes diretas entre o armario e o computador, use o tunel ADB:

```powershell
cd "C:\Users\Usuario\Documents\App armário preddita\preddita-entregas-retiradas-v2\admin-online"
powershell -ExecutionPolicy Bypass -File .\start-admin-online.ps1
```

Isso faz:

- inicia o painel na porta 8787;
- conecta no armario em `192.168.0.39:5555`;
- cria `adb reverse tcp:8787 tcp:8787`;
- permite que o app do armario acesse o painel por `127.0.0.1:8787`.

Observacao: para uso realmente online fora da rede local, hospede esse servidor em nuvem/HTTPS e configure o app do armario para apontar para essa URL.
