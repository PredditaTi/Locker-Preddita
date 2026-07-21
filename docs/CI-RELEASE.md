# CI e release Android

## Objetivo

O repositorio possui dois workflows:

- `CI`: valida cada pull request e cada push na `main`.
- `Release APK`: gera manualmente um APK release assinado e seu SHA-256 e os
  publica em um GitHub Release imutavel.

O CI usa Node.js 20.19, Java 17, Android SDK 34 e Postgres 16. Ele executa os
testes JavaScript, contrato consumidor-servidor, smoke Postgres, fluxo E2E em
Chromium, parser Java RS-485, auditorias de dependencias, build Vite e
`assembleDebug`.

## Secrets obrigatorios para release

Configure estes GitHub Actions secrets no repositorio:

- `PREDDITA_RELEASE_KEYSTORE_BASE64`: keystore JKS codificada em base64.
- `PREDDITA_RELEASE_STORE_PASSWORD`: senha do keystore.
- `PREDDITA_RELEASE_KEY_ALIAS`: alias da chave de assinatura.
- `PREDDITA_RELEASE_KEY_PASSWORD`: senha da chave.

O workflow sempre gera um APK generico, sem URL, `lockerId` ou chave de device.
Depois da instalacao, abra o modo diagnostico no equipamento e use
`Provisionar conexao` para gravar esses dados. A chave HMAC e importada como
nao exportavel no Android Keystore e nunca entra no bundle web ou nos secrets
de build do GitHub.

O build falha se `VITE_PREDDITA_DEVICE_KEY` estiver definido. Essa variavel e
permitida somente no servidor de desenvolvimento do Vite, nunca em um APK.

## Gerar um APK

1. Abra `Actions` no GitHub.
2. Escolha `Release APK`.
3. Selecione `Run workflow`.
4. Escolha `lab`, `pilot` ou `production`.
5. Confirme o GitHub Release criado com a tag `v<versionName>`.
6. Use a URL HTTPS do APK e o conteudo do `.sha256` no painel `Atualizacoes`.

O workflow tambem executa `apksigner verify` antes de publicar o artifact.
O canal precisa corresponder ao sufixo do `versionName`: `-lab`, `-pilot` ou
nenhum sufixo para producao. Uma combinacao incorreta falha antes do upload.
Uma tag existente tambem causa falha: releases nao sao sobrescritas. Para
corrigir um APK, incremente sempre `versionCode` e `versionName`.

A versao `2.0.22-lab` e o bootstrap do atualizador e ainda precisa ser instalada
por ADB nos lockers existentes. Depois dela, releases com `versionCode` maior
podem usar o rollout do Admin Online.

A candidata atual do Kiosk V4 e `2.0.31-lab`, `versionCode 31`. A prerelease
imutavel [`v2.0.31-lab`](https://github.com/PredditaTi/Locker-Preddita/releases/tag/v2.0.31-lab)
foi publicada em 21 de julho de 2026 pelo workflow
[#29860294336](https://github.com/PredditaTi/Locker-Preddita/actions/runs/29860294336).
O APK possui SHA-256
`fd79beaa803d5d031c72e5c576b2a1c52cad7f6df35e761793931aae1576b25c` e a
assinatura v2 foi validada com o certificado lab registrado abaixo.

Por manter o sufixo `-lab`, essa release nao pode ser promovida apenas por
renomeacao: os canais `pilot` e `production` exigem novo nome/versao, nova
validacao e outra release imutavel. Antes de usuarios reais, instale-a em um
unico equipamento e execute os dois preflights descritos em
`docs/KIOSK-V4-PILOTO-CONTROLADO.md`.

## Custodia da chave

A mesma chave deve assinar todas as atualizacoes futuras do aplicativo. Perder
a keystore ou a senha impede atualizar instalacoes existentes sem reinstalar o
app. A keystore nunca deve ser adicionada ao Git e deve possuir backup fora do
computador de desenvolvimento.

Uma chave `lab` serve apenas para laboratorio e piloto controlado. Antes de uma
implantacao comercial, defina formalmente a chave de producao, o responsavel
pela custodia e o procedimento de recuperacao.

Chave lab configurada em 2026-07-15:

- Alias: `preddita-lab`.
- Certificado SHA-256:
  `5E:D9:93:C1:04:91:D5:FF:58:0D:85:D3:BC:C4:5F:53:CE:21:3F:19:9A:F3:44:D3:79:56:A7:AA:F1:9D:59:2D`.
- Copia local ignorada pelo Git: `recovery/signing/preddita-lab-release.jks`.
- Senha local: Chaves do macOS, servico `preddita-lab-release-password`.

## Protecao da main

Depois que o primeiro CI passar, configure a `main` para exigir o check
`Verify project`, impedir force push e exigir pull request para alteracoes.
