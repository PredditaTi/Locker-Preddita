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
os backups e corrija a recuperacao antes de voltar a operar o locker.

Testes de idempotencia remota e protocolo serial:

```powershell
node scripts\v2-remote-command-journal-test.mjs
node scripts\v2-device-event-journal-test.mjs
node scripts\v2-serial-protocol-test.mjs
node scripts\v2-door-safety-test.mjs
```

O teste nativo `scripts\Rs485FrameParserTest.java` tambem roda dentro de
`scripts\v2-verify.ps1` usando o JDK 17.

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

Se quiser pular o build web na verificacao completa:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\v2-verify.ps1 -SkipBuild
```

## CI e release no GitHub

O workflow `CI` executa testes, smoke Postgres, auditorias, build web e gera um
APK debug em cada pull request. O workflow manual `Release APK` restaura a
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
$env:VITE_PREDDITA_EDGE_APP_VERSION="2.0.14-lab"
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
`PREDDITA_DEVICE_KEYS` no servidor. A chave fica no Android Keystore.

Ver versao instalada:

```powershell
& $adb shell dumpsys package com.preddita.entregaslocker | Select-String "versionCode|versionName"
```

## Checklist antes de publicar

- `npm run test:workflow` passou.
- `npm run smoke` passou.
- Testes do diario remoto e parser RS-485 passaram.
- Teste `v2-door-safety-test.mjs` passou.
- `npm run build` passou.
- `gradlew assembleDebug` passou.
- O APK `release` foi assinado com a keystore de producao, nunca com a de debug.
- `PREDDITA_ADMIN_USERS` contem somente hashes scrypt, inclui um
  `super_admin` ativo e restringe cada conta aos lockers necessarios.
- Login, logout, CSRF e os papeis administrativos passaram no smoke test.
- `PREDDITA_DEVICE_KEY` nao usa valor padrao.
- `PREDDITA_DEVICE_AUTH_MODE=hmac` no servidor e assinador nativo ativo no APK.
- O build recusou `VITE_PREDDITA_DEVICE_KEY` e o equipamento aparece como
  provisionado no modo diagnostico.
- `PREDDITA_ALLOWED_ORIGINS` inclui o dominio do painel e
  `https://appassets.androidplatform.net`, usado pelo APK.
- SMTP configurado e testado.
- APK reporta a versao esperada no painel online.
- Armario aparece online, serial aberta e com `/dev/ttyS5`.
- Polaridade do sensor foi comissionada no equipamento com uma porta fechada,
  depois aberta e novamente fechada.
- Deposito, retirada e abertura remota permaneceram ocupados ate a leitura
  individual confirmar o fechamento.

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
