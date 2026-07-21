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

1. entregador busca e confirma o apartamento;
2. porta livre e fechada e selecionada e aberta;
3. deposito so conclui depois da leitura de fechamento;
4. PIN e entrega ficam persistidos;
5. morador informa o PIN e abre a mesma porta;
6. retirada so conclui depois de nova leitura de fechamento;
7. estado `collected` sobrevive ao reload do kiosk;
8. PIN, token, QR e codigo externo nao reaparecem depois do reload;
9. fallback para porta grande espera a prova de fechamento da pequena;
10. cancelamento solicitado com porta aberta preserva a reserva ate fechar;
11. retirada por QR passa pelo decodificador real com camera simulada.

A protecao de regressao tambem inclui:

- `kiosk-layout.spec.js`: geometria, foco, nomes acessiveis e erros do console;
- `kiosk-interactions.spec.js`: teclado, retorno, cancelamento seguro, timeout e
  fallback para porta grande;
- `kiosk-v4-home.spec.js`: marca, ajuda, alvo de toque e contraste WCAG AA;
- `kiosk-v4-prototype.spec.js`: navegacao local pelas cinco referencias V4,
  alvo minimo e ausencia de scroll;
- projetos `1024x600`, `1280x800`, `800x480` e `390x844`;
- falha controlada que prova a deteccao de um botao fora da tela.

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

As referencias da fundacao e das jornadas reais estao em
`docs/KIOSK-V4-FUNDACAO-VISUAL.md` e
`docs/KIOSK-V4-JORNADAS-PUBLICAS.md`.

Em falhas, screenshot, video, trace e arvore acessivel ficam em
`web/test-results`. O CI envia esses arquivos como artifact por sete dias.

## Limites

O E2E valida UI, persistencia e contrato da ponte serial, mas nao substitui o
comissionamento no equipamento. Polaridade, chicote, temporizacao eletrica e
sensor de cada porta continuam exigindo o roteiro fisico antes da instalacao.
