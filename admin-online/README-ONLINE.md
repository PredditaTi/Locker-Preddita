# PREDDITA Admin Online em servidor

Este painel pode rodar em qualquer servidor Node/Docker com HTTPS publico.

## Variaveis obrigatorias

```text
PORT=8787
PREDDITA_DATA_DIR=/data
PREDDITA_STORAGE=postgres
PREDDITA_TENANT_ID=residencial-aurora
PREDDITA_DATABASE_URL=postgresql://preddita:troque-esta-senha@postgres:5432/preddita_locker
PREDDITA_ADMIN_USERS='[{"username":"preddita","name":"Admin Geral PREDDITA","role":"super_admin","passwordHash":"scrypt-v1$...","tenantId":"residencial-aurora","lockerIds":["*"]},{"username":"sindico","name":"Sindico","role":"sindico","passwordHash":"scrypt-v1$...","tenantId":"residencial-aurora","lockerIds":["ks1062-aurora"]}]'
PREDDITA_ADMIN_SESSION_TTL_MS=28800000
PREDDITA_ADMIN_LOGIN_RATE_LIMIT_PER_MINUTE=12
PREDDITA_MFA_ENCRYPTION_KEY=cole-uma-chave-base64-de-32-bytes
PREDDITA_DEVICE_KEY=crie-uma-chave-forte-para-o-armario
PREDDITA_DEVICE_KEYS={"ks1062-aurora":"crie-uma-chave-forte-para-o-armario"}
PREDDITA_LOCKER_ID=ks1062-aurora
PREDDITA_COMMAND_TTL_MS=120000
PREDDITA_COMMAND_LEASE_MS=15000
PREDDITA_COMMAND_EXECUTION_LEASE_MS=30000
PREDDITA_OPERATIONAL_LOG_RETENTION_DAYS=30
PREDDITA_IOT_MODE=disabled
PREDDITA_SMTP_HOST=smtp.seu-provedor.com
PREDDITA_SMTP_PORT=587
PREDDITA_SMTP_SECURE=false
PREDDITA_SMTP_USER=usuario-smtp@seudominio.com
PREDDITA_SMTP_PASS=senha-ou-app-password
PREDDITA_SMTP_FROM="PREDDITA Locker <usuario-smtp@seudominio.com>"
```

Gere cada `passwordHash` com `scripts/generate-admin-password.mjs`; senhas nao
devem ser gravadas no `.env`. Os papeis aceitos sao `sindico`, `operador`,
`suporte` e `super_admin`, e `lockerIds` limita os armarios acessiveis. O valor
`*` e permitido somente para suporte e Admin Geral.
No `.env` do Docker, mantenha a lista inteira entre aspas simples para impedir
que os caracteres `$` dos hashes sejam interpretados pelo Compose.

```bash
read -s PASSWORD && printf '%s\n' "$PASSWORD" | node scripts/generate-admin-password.mjs --username sindico --name "Sindico" --role sindico --locker-id ks1062-aurora
unset PASSWORD
```

No modo Postgres, usuarios, sessoes e revogacoes ficam nas tabelas
`preddita_admin_users` e `preddita_admin_sessions`. O primeiro boot importa
`PREDDITA_ADMIN_USERS`; nos seguintes o servidor consegue restaurar os usuarios
do banco mesmo sem repetir a variavel. Mantenha a variavel no deploy para
reconciliar papeis, senhas, escopos e contas removidas.

O token bruto existe apenas no cookie `HttpOnly`; o banco armazena seu SHA-256.
Um restart preserva sessoes validas, e logout permanece revogado depois de novo
restart. O modo JSON continua com sessoes somente em memoria.

Contas `super_admin` e `suporte` cadastram um autenticador TOTP no primeiro
login. Gere `PREDDITA_MFA_ENCRYPTION_KEY` uma unica vez com
`openssl rand -base64 32` e guarde a chave fora do repositorio. O servidor cifra
o segredo TOTP no Postgres e entrega dez codigos de recuperacao de uso unico.
Trocar ou perder essa chave exige recadastrar o MFA das contas privilegiadas.

As variaveis `PREDDITA_SMTP_*` sao usadas para enviar o PIN e o QR Code por e-mail quando uma entrega e confirmada no armario.

`PREDDITA_DEVICE_KEY` ainda existe como compatibilidade do piloto. Para varios armarios, prefira `PREDDITA_DEVICE_KEYS`, no formato JSON:

```text
PREDDITA_DEVICE_KEYS={"ks1062-aurora":"chave-1","ks1062-torre-b":"chave-2"}
```

## Wake-up com AWS IoT Core

O MQTT e um aviso de baixa latencia, nao a fonte de verdade. O servidor grava a
alteracao ou o comando no Postgres antes de publicar um evento QoS 1 sem dados
pessoais. Ao receber o aviso, o Edge Agent chama o snapshot HTTP autenticado,
que continua responsavel por lease, ACK, idempotencia e estado. Sem MQTT, o
polling HTTP de 6 segundos permanece ativo; conectado, o heartbeat de
contingencia passa a 30 segundos.

Obtenha o hostname Data-ATS:

```bash
aws iot describe-endpoint --endpoint-type iot:Data-ATS --region sa-east-1
```

Configure o servidor sem chaves AWS estaticas, usando a role da instancia,
task ou workload. Essa identidade precisa de `iot:Publish` somente nos topicos
`preddita/v1/tenant/*/locker/*/wake` e `sts:AssumeRole` na role indicada por
`PREDDITA_IOT_DEVICE_ROLE_ARN`.

A role assumida pelo dispositivo precisa confiar na identidade do servidor e
permitir como teto:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "iot:Connect", "Resource": "arn:aws:iot:REGIAO:CONTA:client/preddita-locker-*" },
    { "Effect": "Allow", "Action": "iot:Subscribe", "Resource": "arn:aws:iot:REGIAO:CONTA:topicfilter/preddita/v1/tenant/*/locker/*/wake" },
    { "Effect": "Allow", "Action": "iot:Receive", "Resource": "arn:aws:iot:REGIAO:CONTA:topic/preddita/v1/tenant/*/locker/*/wake" }
  ]
}
```

Em cada ticket, o Admin Online adiciona uma session policy sem curingas,
limitada ao `clientId` e ao topico exato do locker. O endpoint
`GET /api/device/mqtt-ticket` exige a mesma assinatura HMAC do snapshot e
devolve uma URL WSS SigV4 temporaria por 15 minutos por padrao; a URL nunca entra em logs,
estado ou heartbeat.

Depois da infraestrutura pronta, habilite:

```text
PREDDITA_IOT_MODE=aws-iot
PREDDITA_IOT_REGION=sa-east-1
PREDDITA_IOT_ENDPOINT=a1b2c3d4e5f6-ats.iot.sa-east-1.amazonaws.com
PREDDITA_IOT_DEVICE_ROLE_ARN=arn:aws:iam::123456789012:role/preddita-locker-mqtt-device
PREDDITA_IOT_TOPIC_PREFIX=preddita/v1
PREDDITA_IOT_TICKET_TTL_SECONDS=900
```

No painel `Sistema`, confirme `Backend: Configurado` e `MQTT conectado`. Uma
falha de publish ou ticket aparece nos logs operacionais, sem interromper o
fluxo HTTP.

## Laboratorio com Docker

1. Copie esta pasta `admin-online` para a maquina de laboratorio.
2. Crie um arquivo `.env` baseado no `.env.example`.
3. Rode:

```bash
docker compose up -d --build
```

4. Para acesso fora da maquina, configure HTTPS antes de expor a porta `8787`.

## Deploy com Docker + HTTPS automatico

Se o dominio/subdominio ja apontar para a VPS, use o compose de producao com Caddy:

1. Crie o DNS `A` do subdominio, por exemplo `locker.preddita.com`, apontando para o IP da VPS.
2. Copie `.env.production.example` para `.env`.
3. Gere `PREDDITA_ADMIN_USERS` e `PREDDITA_MFA_ENCRYPTION_KEY`; preencha `PREDDITA_DOMAIN`, as chaves dos armarios e `PREDDITA_SMTP_*`.
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

No modo recomendado de producao (`PREDDITA_STORAGE=postgres`), o servidor separa
configuracao, portas e filas auxiliares em `preddita_locker_states`; moradores,
entregas, comandos e auditoria ficam em tabelas relacionais proprias, sempre por
`tenant_id` e `locker_id`. Se existir `/data/state.json` no primeiro boot do
locker padrao, ele e usado como origem inicial. Snapshots Postgres anteriores a
esta estrutura recebem backfill automatico no primeiro acesso, dentro de uma
transacao, sem mudar o formato devolvido pela API.

Logs de requisicao, autenticacao, startup e workers ficam em
`preddita_operational_logs`, separados da auditoria de negocio. O painel de
suporte permite filtrar e exportar CSV; corpo, query string, credenciais, PINs e
dados pessoais nao sao persistidos. A limpeza no startup respeita
`PREDDITA_OPERATIONAL_LOG_RETENTION_DAYS`.

Comandos nao participam mais das substituicoes completas dessas colecoes. Cada
transicao usa bloqueio de linha, `revision` e indices unicos para impedir dois
comandos ativos na mesma porta ou o reuso de um `executionId`. Deadlock e falha
de serializacao recebem ate tres tentativas; o smoke Postgres executa criacao,
lease, ACK e conclusao simultaneamente em duas instancias do servidor.

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
  -LockerId "ks1062-aurora"
```

Depois instale o APK, abra o modo diagnostico e use `Provisionar conexao` para
informar URL, `lockerId` e a chave cadastrada no servidor. A partir disso, o app
busca moradores, envia status e recebe comandos pelo servidor online.

## Observacoes importantes

- Use HTTPS, nao HTTP, para proteger sessoes, senhas e dados operacionais.
- Em producao, use `PREDDITA_STORAGE=postgres`; o volume `/data` fica apenas como fallback/importacao inicial.
- Cada armario deve ter `lockerId` e chave propria.
- O armario precisa ter acesso a internet.
- O computador local e o `adb reverse` deixam de ser necessarios para operacao remota, mas ainda podem ser usados para instalar APKs.
