# Contratos de API e E2E do kiosk

## Objetivo

Esta camada impede que o Admin Online e o app do armario evoluam com formatos
incompativeis. Ela complementa os testes de dominio: o contrato sobe o servidor
real e o E2E percorre a interface publicada com respostas RS-485 deterministicas.

## Contrato consumidor-servidor

`scripts/v2-api-contract-test.mjs` importa o `web/src/remoteBridge.js` usado pelo
Edge Agent e conversa com uma instancia isolada do `admin-online/server.mjs`.
A credencial segue o caminho de producao do Android Keystore: o teste expoe uma
ponte nativa HMAC e nunca grava a chave no bundle web.

O teste valida:

- healthcheck e versoes do contrato;
- login, cookie protegido, sessao e CSRF;
- cadastro de morador e formato recebido pelo locker;
- heartbeat, portas e snapshot autenticado do dispositivo;
- criacao, lease, ACK, execucao e conclusao de comando remoto;
- sincronizacao de evento offline e formato do resultado;
- ticket MQTT desabilitado com fallback HTTP;
- logout e consulta administrativa do resultado final.

Executar na raiz:

```powershell
node scripts\v2-api-contract-test.mjs
```

## Fluxo E2E do kiosk

Os testes em `web/e2e` usam Playwright Chromium contra o bundle gerado em
`android/app/src/main/assets/www`. A fixture compartilhada
`support/kioskTestBridge.js` instala `window.Android` somente no contexto do
navegador de teste e simula frames RS-485 com checksum, leitura de sensor,
abertura e fechamento fisico.

O ambiente web usa Vite 8 e requer Node.js 20.19 ou superior.

A jornada coberta confirma:

1. entregador pode escolher `Entrega Manual` ou `Entrega Inteligente`;
2. entregador busca e confirma o apartamento;
3. porta livre e fechada e selecionada e aberta;
4. deposito so conclui depois da leitura de fechamento;
5. PIN e entrega ficam persistidos;
6. morador informa o PIN e abre a mesma porta;
7. retirada so conclui depois de nova leitura de fechamento;
8. estado `collected` sobrevive ao reload do kiosk;
9. PIN, token, QR e codigo externo nao reaparecem depois do reload;
10. fallback para porta grande espera a prova de fechamento da pequena;
11. cancelamento solicitado com porta aberta preserva a reserva ate fechar;
12. retirada por QR passa pelo decodificador real com camera simulada;
13. a captura inteligente exige quadro estavel, fotografa automaticamente e
    encerra o stream;
14. a captura inteligente nao altera entregas, nao reserva compartimento e nao
    envia comando de abertura quando o resultado e inconclusivo;
15. um resultado simulado `ready` so avanca quando versao e checksum coincidem
    com a bridge;
16. recomendacoes `P/G` exigem revisao antes da reserva e usam somente portas
    do tamanho exato;
17. a foto inteligente e apagada antes da reserva e permanece ausente depois
    da confirmacao do deposito;
18. ausencia de porta `P` nao promove a recomendacao para uma porta `G`.

A protecao de regressao tambem inclui:

- `kiosk-layout.spec.js`: geometria, foco, nomes acessiveis e erros do console;
- `package-capture-quality-test.mjs`: iluminacao, contraste, nitidez e movimento
  com frames sinteticos deterministas;
- `kiosk-interactions.spec.js`: teclado, retorno, cancelamento seguro, timeout e
  fallback para porta grande;
- `kiosk-v4-home.spec.js`: marca, ajuda, alvo de toque e contraste WCAG AA;
- `kiosk-audio.spec.js`: estado mudo, reproducao unica, interrupcao, volume e
  preferencia minima nos quatro viewports;
- `kiosk-v4-prototype.spec.js`: navegacao local pelas cinco referencias V4,
  alvo minimo e ausencia de scroll;
- projetos `1024x600`, `1280x800`, `800x480` e `390x844`;
- falha controlada que prova a deteccao de um botao fora da tela.

## Contrato do analisador local

O WebView usa `window.PredditaPackageAnalyzer`, separado de `window.Android`,
para enviar somente JPEG, data da captura e qualidade. A chamada e aceita de
forma sincrona, executada em uma fila Android de uma posicao ativa e concluida
pelo evento `preddita-package-analysis` com o mesmo `requestId`.

O adaptador recusa schema desconhecido, resposta sem correlacao, tamanho fora
de `P/G`, confianca abaixo de `0,90`, modelo divergente e recomendacao com mais
de dois minutos. Bridge ausente, fila ocupada, timeout, modelo ausente ou
checksum divergente terminam de forma inconclusiva e nao chamam qualquer API
de porta. O contrato completo esta em
`docs/CONTRATO-ANALISADOR-LOCAL.md`.

O baseline visual, as metricas e o rollback correspondente estao em
`docs/KIOSK-V3-BASELINE.md`.

Preparar e executar em `web`:

```powershell
npx playwright install chromium
npm run build
npm run test:e2e
```

Para regenerar intencionalmente a referencia V3:

```powershell
npm run capture:baseline
```

Para regenerar a home responsiva e os prototipos da fundacao V4:

```powershell
npm run capture:v4-foundation
```

Para regenerar as 13 referencias das jornadas reais V4:

```powershell
npm run capture:v4-journeys
```

Para validar os prompts e capturar o dialogo de orientacao sonora:

```powershell
npm run test:audio
npm run capture:v4-audio
```

As referencias da fundacao e das jornadas reais estao em
`docs/KIOSK-V4-FUNDACAO-VISUAL.md` e
`docs/KIOSK-V4-JORNADAS-PUBLICAS.md`. A politica e as evidencias de audio ficam
em `docs/KIOSK-V4-AUDIO-ACESSIVEL.md`.

O console tecnico possui uma matriz E2E separada em
`web/e2e/kiosk-diagnostics.spec.js`. Ela prova bloqueio por URL/credencial,
PIN invalido, seis abas, allowlist simulada, limites de tela, confirmacao e
prova da porta, auditoria e timeout nos quatro viewports. O contrato detalhado
esta em `docs/KIOSK-V4-CONSOLE-TECNICO.md`.

Em falhas, screenshot, video, trace e arvore acessivel ficam em
`web/test-results`. O CI envia esses arquivos como artifact por sete dias.

## Contrato de saude do update

`device.appUpdater.status` aceita tambem `installed-pending-health`, `healthy`,
`degraded` e `failed-health`. O objeto `health` informa apenas booleanos de
prontidao, datas, codigo serial sanitizado e prazo; `healthFailureCode` e
`recommendedAction` explicam o diagnostico sem URL do APK, segredo, caminho ou
conteudo do estado local.

O smoke publica um `failed-health`, confere a amostra deduplicada e prova que a
politica e pausada e que `/api/device/snapshot` nao devolve novamente a mesma
release. Os contratos Java cobrem startup e timeout; os contratos JavaScript
cobrem backup sem dados pessoais e o handoff do Edge Agent.

## Contrato de metricas do piloto

`POST /api/device/events` aceita `type: "pilot-metric"` pelo mesmo envelope HMAC
e idempotente usado na sincronizacao offline. O servidor descarta qualquer
campo fora de:

```json
{
  "schemaVersion": 2,
  "journeyType": "courier",
  "outcome": "completed",
  "durationMs": 125000,
  "pickupMode": "none",
  "usedSizeFallback": true,
  "helpRequested": false,
  "errorCount": 0,
  "reasonCode": "none",
  "deliveryMode": "smart",
  "smartAnalysisOutcome": "P",
  "smartRecommendationConfirmed": true,
  "smartDoorOutcome": "opened"
}
```

Os campos enumerados usam allowlists fechadas; duracao e erros sao limitados.
O servidor conserva no maximo 500 amostras por locker e remove amostras com
mais de 30 dias. O smoke envia propositalmente apartamento e PIN extras e
confirma que esses campos nao aparecem no estado administrativo. Os testes
`pilot-metrics-test.mjs` e `pilot-preflight-test.mjs` cobrem restart, retencao,
limites, agregacao e gates do piloto.

## Limites

O E2E valida UI, persistencia e contrato da ponte serial, mas nao substitui o
comissionamento no equipamento. Polaridade, chicote, temporizacao eletrica e
sensor de cada porta continuam exigindo o roteiro fisico antes da instalacao.
