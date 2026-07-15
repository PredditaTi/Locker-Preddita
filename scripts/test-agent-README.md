# PREDDITA Locker — Test Agent

Agente standalone Node que valida a experiência do usuário no armário v2 cobrindo quatro frentes:

1. **Health & contrato** — só GETs, sempre seguro.
2. **UX rules puras** — importa `web/src/lockerWorkflow.js` e exercita as regras que o React usa (alocação de porta por tamanho, geração de PIN, formato do QR, transições de estado).
3. **Erros do usuário** — PIN errado, QR mal formatado, retirada de entrega cancelada, sem porta livre.
4. **Segurança / autorização** — gera 401 com credenciais erradas, valida que síndico não enxerga `platform`, opcionalmente força rate limit.

Mutações reais (cadastrar morador, publicar status do device, abrir porta, enviar e-mail) ficam atrás de flags em camada — por padrão **o agente não escreve nada**.

## Pré-requisitos

- Node 20+.
- Credenciais da instância v2 que você quer testar:
  - `PREDDITA_ADMIN_USERNAME` e `PREDDITA_ADMIN_PASSWORD` (síndico) — necessários para a maioria dos testes.
  - `PREDDITA_SUPER_ADMIN_USERNAME` e `PREDDITA_SUPER_ADMIN_PASSWORD` — opcionais.
  - `PREDDITA_DEVICE_KEY` — chave do armário, para os testes que simulam o device.
- Acesso de rede ao Admin Online por uma URL HTTPS.

> Nunca cole senhas ou chaves em arquivo commitado nem em histórico de shell. Use `read -s`, `pass`, `1Password CLI`, ou `aws ssm get-parameter`.

## Uso mínimo (read-only contra EC2)

```bash
cd preddita-entregas-retiradas-v2

read -p "Admin user:   " PREDDITA_ADMIN_USERNAME
read -s -p "Admin senha: " PREDDITA_ADMIN_PASSWORD; echo
read -s -p "Device key:   " PREDDITA_DEVICE_KEY; echo
export PREDDITA_ADMIN_USERNAME PREDDITA_ADMIN_PASSWORD PREDDITA_DEVICE_KEY

node scripts/test-agent.mjs --base https://locker.example.com
```

Saída esperada (exemplo abreviado):

```
========================================================================
  PREDDITA Locker — Test Agent
========================================================================
Base:      https://locker.example.com
...
-- 1. Health & contrato (read-only)
  PASS GET /api/healthz responde 200 — appVersion=2.0.15-lab schemaVersion=7
  PASS GET admin/state com sessao de sindico devolve estado completo — 24 portas, 3 apartamentos, 0 entregas
  ...
-- 4. Seguranca / autorizacao (gera 401/429)
  PASS admin/state sem sessao responde 401
  ...
========================================================================
  RESUMO
========================================================================
PASS: 22
FAIL: 0
SKIP: 5    (rate-limit, mutações, atuação, e-mail — desabilitados)
```

## Flags

| Flag | Habilita | Risco |
|---|---|---|
| (nenhuma) | Health, UX puras, erros, autorização básica | nenhum |
| `--rate-limit` | Stress no rate limit do admin (~220 req em sequência) | barulhento, gera 429 |
| `--write` | Cadastra um apartamento `TEST-AGENT-<timestamp>` e remove em seguida; publica status do device | escreve em produção, mas reverte |
| `--actuate` | Cria comando para a porta 1 e valida lease, ACK e `/complete` | **pode abrir a porta física** se o armario real capturar o comando antes do agente |
| `--send-email` | Dispara `/api/device/deliveries/notify` para `PREDDITA_TEST_EMAIL` | **envia e-mail real**; uso de quota do SMTP |

Cada flag superior implica conscientização sobre o impacto. O agente loga aviso vermelho ao iniciar quando `--actuate` ou `--send-email` estão ligadas.

## Exemplos

### Read-only contra produção

```bash
node scripts/test-agent.mjs \
  --base https://locker.example.com \
  --admin-user "$PREDDITA_ADMIN_USERNAME" \
  --device-key  "$PREDDITA_DEVICE_KEY" \
  --report ./out/test-agent-prod.json
```

### Read-only + super admin + relatório JSON

```bash
node scripts/test-agent.mjs \
  --base https://locker.example.com \
  --admin-user "$PREDDITA_ADMIN_USERNAME" \
  --super-user "$PREDDITA_SUPER_ADMIN_USERNAME" \
  --device-key  "$PREDDITA_DEVICE_KEY" \
  --report ./out/test-agent-prod.json
```

### Mutações seguras (cria e apaga apartamento de teste)

```bash
node scripts/test-agent.mjs \
  --base https://locker.example.com \
  --admin-user "$PREDDITA_ADMIN_USERNAME" \
  --device-key  "$PREDDITA_DEVICE_KEY" \
  --write
```

O apartamento criado tem prefixo `TEST-AGENT-` e é apagado imediatamente. Se o teste falhar no meio, o registro pode ficar — basta remover pelo painel.

### End-to-end com abertura real (uso controlado)

```bash
# Avise o operador no local antes!
node scripts/test-agent.mjs \
  --base https://locker.example.com \
  --admin-user "$PREDDITA_ADMIN_USERNAME" \
  --device-key  "$PREDDITA_DEVICE_KEY" \
  --write --actuate
```

A suite de atuação cria comando para a **porta 1**, reserva via
`/api/device/snapshot`, envia ACK e completa com o mesmo `executionId`. Se o
armario real estiver conectado ao mesmo Admin Online, ele pode capturar o lease
antes do agente e **abrir a porta fisicamente**. Para testar outra porta, edite a
constante `door = 1` em `suiteActuation`.

### E-mail real

```bash
export PREDDITA_TEST_EMAIL="seu.email@preddita.com"
node scripts/test-agent.mjs \
  --base https://locker.example.com \
  --device-key "$PREDDITA_DEVICE_KEY" \
  --send-email
```

Dispara um e-mail com PIN `000000` e QR fake; serve para validar que SMTP está configurado e entrega para a caixa.

### Filtrar uma suite

```bash
node scripts/test-agent.mjs --only auth --admin-user ...
node scripts/test-agent.mjs --only ux
node scripts/test-agent.mjs --only health
```

## Exit code

- `0` — todos os testes que rodaram passaram.
- `1` — pelo menos um teste falhou.
- `2` — erro fatal (CLI inválido, dependência não disponível, etc.).

Útil para CI: `node scripts/test-agent.mjs --report out.json && echo "ok"`.

## O que o agente **não** cobre

- UI nativa (WebView Capacitor) — o CI valida o contrato HMAC em Java e simula a ponte nativa, mas o provisionamento no Android Keystore ainda exige teste em aparelho.
- Comportamento elétrico/mecânico das fechaduras — só testa se o admin recebeu confirmação.
- Latência sob carga real — `--rate-limit` é um bombardeio simples, não simula uso.
- Recuperação de `state.json` corrompido — precisa de fixture específica.

## Próximos passos sugeridos

- Promover este agente a `npm test` no `package.json`.
- Rodar via cron no EC2 (modo read-only) e alertar via webhook se `fail > 0`.
- Quando houver pipeline CI, rodar a versão read-only contra um sandbox antes de cada deploy.
- Migrar para Vitest quando os testes começarem a se sobrepor — hoje o ganho é speed e zero dependência.

## Como evoluir os testes

Cada suite é uma função `async (api, runner, args)` que chama `runner.suite('nome', async () => { ... })` e dentro dele `runner.test('descricao', async () => { ... })`. `runner.test` pega qualquer função que retorna ou faz `assert(...)`/`assertEqual(...)` — se nada lançar, passa. Para adicionar um caso novo:

1. Identifique a suite (ou crie uma nova chamando `runner.suite(...)` no `main`).
2. Escreva um `runner.test('o que estamos validando', async () => { ... })`.
3. Use o `api` para chamadas HTTP, ou importe direto do `web/src/lockerWorkflow.js` para regras puras.
4. Retorne uma string curta com o detalhe (ex: `"PIN 123456, porta 4"`) — aparece no log.
