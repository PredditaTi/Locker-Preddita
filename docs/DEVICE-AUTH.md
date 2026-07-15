# Autenticacao HMAC do armario

As rotas `/api/device/*` usam HMAC-SHA256 para autenticar o armario e garantir
integridade da requisicao. O APK e o servidor devem compartilhar uma chave
exclusiva por `lockerId`, configurada no servidor por `PREDDITA_DEVICE_KEYS`.

## Cabecalhos

- `x-locker-id`: identificador do armario.
- `x-preddita-timestamp`: horario Unix em milissegundos.
- `x-preddita-nonce`: valor aleatorio unico por tentativa.
- `x-preddita-content-sha256`: SHA-256 hexadecimal do corpo HTTP exato.
- `x-preddita-signature`: `v1=` seguido do HMAC-SHA256 hexadecimal.

A entrada do HMAC e formada por linhas separadas por `\n`:

```text
PREDDITA-HMAC-V1
METODO
/rota?query
lockerId
timestamp
nonce
sha256-do-corpo
```

O servidor compara hashes e assinatura em tempo constante, recusa timestamps
fora da janela configurada e aceita cada nonce somente uma vez durante essa
janela. A protecao de nonce atual e local ao processo; uma futura execucao com
varias replicas deve mover esse registro para um armazenamento compartilhado.

## Modos do servidor

- `hmac`: unico modo permitido com `NODE_ENV=production`.
- `dual`: aceita HMAC e, sem cabecalho de assinatura, a chave estatica antiga.
  Serve apenas para migracao em laboratorio.
- `legacy`: aceita somente `x-device-key`. Serve apenas para diagnosticar um APK
  antigo em ambiente isolado.

O servidor local usa `dual` por padrao. O APK usa o assinador nativo por padrao.
Uma assinatura HMAC presente e invalida nunca faz fallback para a chave legada.

## Android Keystore

O APK nao recebe a chave durante o build. No modo diagnostico, o comando
`Provisionar conexao` abre um dialogo Android nativo para URL, `lockerId` e
chave. A chave e importada no alias `preddita_device_hmac_v1` do Android
Keystore como HMAC-SHA256 nao exportavel. Apenas URL, `lockerId` e horario de
provisionamento ficam em `SharedPreferences` privados.

O JavaScript recebe somente os metadados nao sensiveis e chama
`PredditaDeviceAuth.signRequest(...)`. O Android valida que a rota pertence a
`/api/device/*`, monta o contrato canonico e devolve apenas a assinatura.

## Migracao

1. Publique o servidor novo em homologacao com
   `PREDDITA_DEVICE_AUTH_MODE=dual`.
2. Gere e instale o APK novo, que nao contem credenciais.
3. Abra o modo diagnostico no armario e toque em `Provisionar conexao`.
4. Informe a URL HTTPS, o `lockerId` e a mesma chave individual registrada em
   `PREDDITA_DEVICE_KEYS` no servidor.
5. Confirme no painel que o heartbeat e os comandos funcionam.
6. Altere o servidor para `PREDDITA_DEVICE_AUTH_MODE=hmac`.
7. Reinicie e confirme que uma chamada apenas com `x-device-key` recebe `401`.

Em producao, mantenha `PREDDITA_DEVICE_SIGNATURE_TTL_MS=120000` e sincronize o
relogio do servidor e do Android. HTTPS continua obrigatorio: HMAC nao substitui
TLS. O Keystore impede a extracao direta da chave, mas o app instalado continua
sendo um oraculo de assinatura; por isso a WebView permanece restrita aos assets
internos e o backend limita as rotas e a taxa do dispositivo.
