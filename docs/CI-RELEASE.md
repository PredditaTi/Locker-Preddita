# CI e release Android

## Objetivo

O repositorio possui dois workflows:

- `CI`: valida cada pull request e cada push na `main`.
- `Release APK`: gera manualmente um APK release assinado e seu SHA-256.

O CI usa Node.js 20, Java 17, Android SDK 34 e Postgres 16. Ele executa os
testes JavaScript, o smoke Postgres, o parser Java RS-485, auditorias de
dependencias, o build Vite e `assembleDebug`.

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
5. Baixe o artifact produzido ao final do job.
6. Confira o APK com o arquivo `.sha256` antes de instalar.

O workflow tambem executa `apksigner verify` antes de publicar o artifact.
O canal precisa corresponder ao sufixo do `versionName`: `-lab`, `-pilot` ou
nenhum sufixo para producao. Uma combinacao incorreta falha antes do upload.

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
