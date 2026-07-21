# PREDDITA Entregas Locker - Runbook de desenvolvimento

Use este guia para mexer no projeto com seguranca. O armario controla hardware
real, entao a regra principal e: teste regra de negocio localmente antes de
instalar no equipamento.

## Pastas

- `web/`: app React do armario.
- `android/`: APK Android que embute o build de `web/`.
- `admin-online/`: servidor/painel online.
- `scripts/`: testes, deploy e ferramentas auxiliares.
- `docs/`: documentacao tecnica.

## Setup local

```powershell
# Abra um PowerShell na raiz desta pasta do projeto.

cd web
npm install

cd ..\admin-online
npm install
```

Observacao: o caminho da maquina atual tem acento e espaco. Se for navegar por
um caminho absoluto, use aspas no PowerShell.

## Testes principais

Regra de negocio do armario:

```powershell
cd web
npm run test:workflow
```

Smoke do Admin Online:

```powershell
cd admin-online
npm run smoke
```

Teste de recuperacao do estado JSON (BOM e arquivo invalido):

```powershell
cd admin-online
npm run test:recovery
```

O servidor aceita um BOM UTF-8 valido, mas nunca substitui automaticamente um
`state.json` que nao possa ser lido. Nessa situacao, preserve o arquivo, confira
os backups e corrija a recuperacao antes de voltar a operar o locker. Um estado
valido recuperado pode ser regravado depois que o ciclo de privacidade remover
credenciais terminais ou dados vencidos; antes disso, o conteudo original fica
preservado em backup conforme a politica de retencao.

Testes de idempotencia remota e protocolo serial:

```powershell
node scripts\v2-remote-command-journal-test.mjs
node scripts\v2-device-event-journal-test.mjs
node scripts\v2-serial-protocol-test.mjs
node scripts\v2-door-safety-test.mjs
node scripts\v2-commissioning-test.mjs
node scripts\CommandWakeupTest.mjs
node scripts\IotCommandBusTest.mjs
node scripts\v2-api-contract-test.mjs
```

Fluxo completo de deposito e retirada no navegador:

```powershell
cd web
npx playwright install chromium
npm run build
npm run test:e2e
```

O teste E2E serve o mesmo bundle copiado para os assets Android. Consulte
`docs/API-CONTRACTS-E2E.md` para o contrato coberto e os artefatos de falha.

Para gerar novamente screenshots e metricas do baseline em `1024x600`:

```powershell
npm run capture:baseline
```

Esse comando substitui `docs/assets/kiosk-v3-baseline`; publique a mudanca
somente quando a nova referencia for intencional e estiver registrada em
`docs/UPDATES.md`.

Para gerar a home responsiva e as cinco referencias da fundacao V4:

```powershell
npm run capture:v4-foundation
```

O comando substitui `docs/assets/kiosk-v4-foundation`, inclui metricas do
bundle e deve registrar zero erro de console. Os prototipos usam dados
ficticios e nao inicializam o Edge Agent nem a ponte de hardware. Consulte
`docs/KIOSK-V4-FUNDACAO-VISUAL.md` antes de aprovar ou substituir as imagens.

Para gerar as 13 referencias das jornadas publicas V4 integradas:

```powershell
npm run capture:v4-journeys
```

O comando substitui `docs/assets/kiosk-v4-journeys`, percorre entrega pequena,
fallback grande, retirada, erro e timeout com o bridge RS-485 de teste e grava
as metricas do bundle. Consulte `docs/KIOSK-V4-JORNADAS-PUBLICAS.md`.

Para validar a politica de audio e regenerar as referencias do dialogo:

```powershell
npm run test:audio
npm run capture:v4-audio
```

O primeiro comando confere allowlist, privacidade e integridade dos 12 prompts.
O segundo substitui `docs/assets/kiosk-v4-audio` com capturas em `1024x600` e
`390x844`. Consulte `docs/KIOSK-V4-AUDIO-ACESSIVEL.md`. Nao publique os audios
atuais em producao antes de confirmar o direito de distribuicao da voz usada.

O teste nativo `scripts\Rs485FrameParserTest.java` tambem roda dentro de
`scripts\v2-verify.ps1` usando o JDK 17.

Com `PREDDITA_TEST_DATABASE_URL`, o smoke Postgres tambem reinicia o servidor
tres vezes: confirma restauracao sem novo bootstrap, logout duravelmente
revogado e invalidacao das sessoes anteriores depois de rotacionar a senha.

Build web do armario:

```powershell
cd web
npm run build
```

Build Android:

```powershell
cd android
.\gradlew.bat assembleDebug
```

No macOS, instale o Android SDK 34 pelo Android Studio e exponha o caminho antes
do primeiro build:

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
cd android
./gradlew assembleDebug
```

O arquivo `android/local.properties`, quando criado pelo Android Studio, e local
da maquina e permanece ignorado pelo Git.

O build `release` nao usa a chave de debug. Configure a keystore de producao no
ambiente de build antes de publicar:

```powershell
$env:PREDDITA_RELEASE_KEYSTORE="C:\caminho\preddita-release.jks"
$env:PREDDITA_RELEASE_STORE_PASSWORD="senha-do-keystore"
$env:PREDDITA_RELEASE_KEY_ALIAS="preddita"
$env:PREDDITA_RELEASE_KEY_PASSWORD="senha-da-chave"
```

Esses valores nunca devem ser gravados no repositorio. HTTP sem TLS fica
disponivel apenas na variante `debug`; o release exige uma URL HTTPS para o
Admin Online.

Bateria completa:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\v2-verify.ps1
```

Se quiser pular o build web e o E2E Playwright na verificacao completa:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\v2-verify.ps1 -SkipBuild
```

## Comissionar um locker

No equipamento, toque sete vezes no canto superior direito em menos de cinco
segundos e informe `VITE_PREDDITA_DIAGNOSTIC_PIN`. Abra a aba
`Comissionamento`, configure board, quantidade de portas e tempo de acionamento,
e teste cada canal com a porta inicialmente fechada.

O primeiro teste detecta a polaridade. Em cada canal, confirme visualmente que
somente a porta indicada abriu, escolha o tamanho fisico `P`, `M` ou `G` e feche
a porta. O botao de conclusao so e liberado depois da prova
fechada-aberta-fechada em todos os canais.

Durante desenvolvimento, `http://127.0.0.1:5174/?diagnostics=1` abre o modo
tecnico diretamente. Esse atalho existe apenas no build de desenvolvimento.

## CI e release no GitHub

O workflow `CI` executa testes, smoke Postgres com duas instancias concorrentes,
auditorias, build web e gera um APK debug em cada pull request. O workflow manual `Release APK` restaura a
keystore a partir de GitHub Actions secrets, gera o release assinado, valida a
assinatura e publica o APK com seu SHA-256.

Consulte `docs/CI-RELEASE.md` para configurar secrets, executar o release e
manter a custodia da chave de assinatura.

## Rodar localmente

Admin Online:

```powershell
cd admin-online
npm start
```

App do armario em navegador:

```powershell
cd web
npm run dev -- --host 127.0.0.1 --port 5174
```

## Build com defaults do Admin Online

URL e `lockerId` podem preencher o dialogo de provisionamento. A chave nunca
deve entrar no build web:

```powershell
cd web
$env:VITE_PREDDITA_REMOTE_URL="https://locker.example.com"
$env:VITE_PREDDITA_LOCKER_ID="ks1062-aurora"
$env:VITE_PREDDITA_DEVICE_AUTH_MODE="hmac"
$env:VITE_PREDDITA_EDGE_APP_VERSION="2.0.31-lab"
npm run build
Remove-Item Env:VITE_PREDDITA_REMOTE_URL
Remove-Item Env:VITE_PREDDITA_LOCKER_ID
Remove-Item Env:VITE_PREDDITA_DEVICE_AUTH_MODE
Remove-Item Env:VITE_PREDDITA_EDGE_APP_VERSION
```

Depois:

```powershell
cd ..\android
.\gradlew.bat assembleDebug
```

## Configurar privacidade e retencao

Antes de publicar o Admin Online, defina o controlador, o contato para
solicitacoes e confirme os prazos com quem responde pelo tratamento dos dados:

```powershell
$env:PREDDITA_PRIVACY_CONTROLLER_NAME="Condominio Residencial Aurora"
$env:PREDDITA_PRIVACY_CONTACT_EMAIL="lgpd@condominio.example.com"
$env:PREDDITA_DELIVERY_EVIDENCE_RETENTION_DAYS="30"
$env:PREDDITA_DELIVERY_PERSONAL_DATA_RETENTION_DAYS="90"
$env:PREDDITA_DELIVERY_RECORD_RETENTION_DAYS="730"
$env:PREDDITA_AUDIT_RETENTION_DAYS="365"
$env:PREDDITA_COMMAND_RETENTION_DAYS="365"
$env:PREDDITA_NOTIFICATION_RETENTION_DAYS="30"
$env:PREDDITA_PROCESSED_EVENT_RETENTION_DAYS="365"
$env:PREDDITA_BACKUP_RETENTION_DAYS="7"
```

No painel, `Privacidade` mostra os prazos e itens vencidos. `Executar agora`
aplica a politica; a mesma rotina roda no startup, antes de persistir estado e a
cada seis horas. Use `Exportar dados` somente depois de validar a identidade do
solicitante. `Eliminar cadastro` e irreversivel e fica bloqueado se houver uma
entrega ativa. O procedimento completo e suas limitacoes estao em
`docs/PRIVACY-DATA-LIFECYCLE.md`.

## Instalar no armario por ADB

```powershell
$adb="C:\Users\Usuario\Desktop\platform-tools\adb.exe"
$apk = Join-Path (Get-Location) "android\app\build\outputs\apk\debug\app-debug.apk"
& $adb connect 192.168.0.39:5555
& $adb install -r $apk
& $adb shell am start -n com.preddita.entregaslocker/.MainActivity
```

No equipamento, abra o modo diagnostico, toque em `Provisionar conexao` e
informe a URL HTTPS, o `lockerId` e a chave individual cadastrada em
`PREDDITA_DEVICE_KEYS` no servidor. No primeiro provisionamento, informe tambem
um PIN tecnico local de 8 a 12 digitos. A chave fica no Android Keystore e o
PIN original nao e persistido. Consulte `docs/KIOSK-V4-CONSOLE-TECNICO.md`.

Ver versao instalada:

```powershell
& $adb shell dumpsys package com.preddita.entregaslocker | Select-String "versionCode|versionName"
```

## Publicar uma atualizacao remota

`2.0.22-lab` introduz o bridge nativo do atualizador. Instale essa versao uma
vez por ADB em cada equipamento existente; o rollout remoto passa a valer para
`versionCode 25` e superiores.

1. Incremente `versionCode` e `versionName` em `android/app/build.gradle`.
2. Mescle a versao validada na `main` e execute `Release APK` com o canal
   correspondente. O workflow cria uma release imutavel com o APK e `.sha256`.
3. Entre no Admin Online como `suporte` ou `super_admin` e abra `Atualizacoes`.
4. Informe a tag da release, as duas versoes, a URL HTTPS do asset e os 64
   caracteres do checksum. Comece com rollout pequeno e aumente depois de
   confirmar a telemetria dos lockers piloto.
5. Pause a distribuicao no painel se houver falha. Nao publique downgrade:
   corrija o problema em um novo `versionCode`, assinado pela mesma keystore.

O Edge Agent so entrega o manifesto ao Android quando a tela inicial esta
ociosa, sem porta aguardando deposito/retirada e sem comando remoto no ciclo.
O Android revalida o arquivo depois do download e antes de retomar uma
instalacao que aguardava permissao. Na primeira atualizacao, o sistema pode
solicitar ao operador que autorize esta fonte de instalacao.

## Checklist antes de publicar

- `npm run test:workflow` passou.
- `npm run smoke` passou.
- Testes do diario remoto e parser RS-485 passaram.
- Teste `v2-door-safety-test.mjs` passou.
- `npm run build` passou.
- `npm run test:diagnostics` e `npx playwright test e2e/kiosk-diagnostics.spec.js` passaram.
- `gradlew assembleDebug` passou.
- O APK `release` foi assinado com a keystore de producao, nunca com a de debug.
- O GitHub Release possui o APK e `.sha256`, e a URL/checksum do rollout
  correspondem exatamente a esses assets.
- `PREDDITA_ADMIN_USERS` contem somente hashes scrypt, inclui um
  `super_admin` ativo e restringe cada conta aos lockers necessarios.
- Login, logout, CSRF e os papeis administrativos passaram no smoke test.
- `PREDDITA_MFA_ENCRYPTION_KEY` foi gerada fora do repositorio, esta protegida
  no deploy e o cadastro TOTP de `super_admin` e `suporte` foi validado.
- O smoke Postgres confirmou `operational_schema_version=1`, as quatro tabelas
  operacionais e o backfill de um snapshot legado sem duplicacao no JSONB.
- `PREDDITA_DEVICE_KEY` nao usa valor padrao.
- `PREDDITA_DEVICE_AUTH_MODE=hmac` no servidor e assinador nativo ativo no APK.
- O build recusou `VITE_PREDDITA_DEVICE_KEY` e o equipamento aparece como
  provisionado no modo diagnostico.
- `PREDDITA_ALLOWED_ORIGINS` inclui o dominio do painel e
  `https://appassets.androidplatform.net`, usado pelo APK.
- Se MQTT estiver habilitado, `PREDDITA_IOT_*` aponta para o endpoint Data-ATS e
  a role temporaria; o painel mostra `MQTT conectado` e o polling de contingencia
  foi exercitado com o broker indisponivel.
- SMTP configurado e testado.
- APK reporta a versao esperada no painel online.
- Armario aparece online, serial aberta e com `/dev/ttyS5`.
- Polaridade do sensor foi comissionada no equipamento com uma porta fechada,
  depois aberta e novamente fechada.
- Deposito, retirada e abertura remota permaneceram ocupados ate a leitura
  individual confirmar o fechamento.

## Preflight do piloto controlado

Os testes sem hardware podem ser executados em qualquer plataforma:

```powershell
node .\scripts\pilot-metrics-test.mjs
node .\scripts\pilot-preflight-test.mjs
```

No servidor que possui `state.json`, execute com as mesmas variaveis de
autenticacao do Admin:

```powershell
$env:PREDDITA_DEVICE_AUTH_MODE="hmac"
node .\scripts\pilot-preflight.mjs --state .\admin-online\data\state.json --expected-version 2.0.31-lab
```

No equipamento conectado por ADB, `deploy.ps1 pilot-check` ou
`./scripts/deploy.sh pilot-check` valida pacote, versao, processo e existencia
da serial sem enviar frame RS-485. Um retorno diferente de zero bloqueia o
piloto. A matriz completa, criterios de parada e recuperacao ficam em
`docs/KIOSK-V4-PILOTO-CONTROLADO.md`.

## Como revisar uma mudanca

1. Se mexeu em regra de porta/entrega, adicione caso em
   `scripts/v2-workflow-test.mjs`.
2. Se mexeu em API, comando remoto, e-mail ou eventos offline, adicione caso em
   `scripts/v2-smoke-test.mjs`.
3. Se mexeu em UI do armario, teste no navegador local e depois no equipamento.
4. Se mexeu em protocolo RS-485, rode diagnostico no armario antes de entregar a
   alteracao.
5. Se mexeu em deploy, atualize `admin-online/README.md`,
   `docs/ARCHITECTURE.md` ou este runbook.

## Depuracao rapida

Armario nao abre porta:

- Verificar se o app mostra serial aberta.
- Confirmar cabo RS-485 A/B e energia da placa.
- Rodar diagnostico no app ou `web/src/diagnostics.js`.
- Conferir a timeline `pending`, `leased`, `executing` e `completed/failed` no
  painel.
- No Postgres, conferir `revision`, `lease_id`, `execution_id` e `delivery_attempt`
  em `preddita_commands`; o mesmo `executionId` nao pode aparecer em duas linhas.
- Conferir em `Sistema` se a polaridade selecionada corresponde ao byte lido
  com a porta fechada e aberta. Nao troque o perfil sem repetir o teste fisico.

E-mail nao chegou:

- Verificar `PREDDITA_SMTP_*`.
- Checar status da entrega no painel: `sent`, `failed`, `pending` ou `skipped`.
- Reenviar pela tela `Entregas`.
- Se o armario ficou sem internet, aguardar sincronizacao de eventos offline.

Painel nao abre porta remotamente:

- Confirmar que o armario esta online e `deviceFresh`.
- Confirmar `serialOpen`.
- Conferir se ja existe comando pendente para a mesma porta.
- Verificar login, papel e locker permitido do usuario administrativo.
- Em `Sistema`, conferir o transporte de comandos. Se MQTT estiver desconectado,
  buscar `iot-device-wakeup-failed` ou `iot-device-ticket-failed` nos logs; o
  snapshot HTTP deve continuar chegando a cada 6 segundos.
