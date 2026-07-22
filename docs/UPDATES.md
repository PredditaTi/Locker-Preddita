# Atualizacoes da documentacao

Esta pagina e o historico oficial de mudancas na documentacao do PREDDITA
Locker. Ela existe para que uma pessoa consiga descobrir rapidamente o que foi
revisado sem comparar manualmente todos os arquivos do repositorio.

> Regra: toda criacao, remocao ou alteracao relevante em `README.md`, `docs/`,
> procedimentos de deploy ou exemplos de configuracao deve gerar uma entrada
> nesta pagina, com a mais recente no topo.

## Como registrar uma atualizacao

Cada entrada deve informar:

- data;
- versao ou commit do produto usado como base;
- resumo do que mudou;
- motivo da atualizacao;
- impacto para desenvolvimento, operacao ou usuario;
- documentos e arquivos envolvidos;
- validacao realizada;
- PR ou release, quando existir.

Nao inclua senhas, chaves, cookies, tokens, dados pessoais, IPs privados reais
ou qualquer outro segredo. Use nomes de variaveis e exemplos ficticios.

## Modelo

Copie este bloco logo abaixo de `## Registro`, mantendo a ordem da mais recente
para a mais antiga:

```markdown
### AAAA-MM-DD - Titulo curto

**Base:** versao, tag ou commit

**O que mudou**

- Mudanca objetiva.

**Por que**

- Motivo, risco ou necessidade.

**Impacto**

- Consequencia pratica para quem desenvolve, instala ou opera.

**Arquivos**

- `caminho/do/documento.md`

**Validacao**

- Conferencia ou teste realizado.

**Referencia:** PR, issue ou release, quando existir.
```

## Registro

### 2026-07-22 - Backend HTTPS e candidata 2.0.32-lab provisionados

**Base:** release `v2.0.32-lab`, `versionCode 32`, commit
`ed67288a59805babbc0bb3ff58b90a16bf3d44e2`

**O que mudou**

- O Admin Online foi publicado em HTTPS no Railway com Postgres 16,
  `schemaVersion 13` e autenticacao HMAC obrigatoria para o dispositivo.
- O KS1062 recebeu a URL HTTPS, o identificador do locker, a chave HMAC no
  Android Keystore e o PIN tecnico local, sem gravar credenciais no Git.
- O Android passou a persistir os sinais de inicio, WebView e serial mesmo em
  uma instalacao direta, permitindo que o preflight reconheca uma credencial
  ja provisionada sem depender de um rollout em andamento.
- A release assinada `v2.0.32-lab` foi publicada, conferida e instalada sobre a
  `2.0.31-lab`, preservando o estado local.

**Por que**

- O piloto precisava de um backend HTTPS persistente e de autenticacao nativa
  antes de validar sincronizacao, saude e rollout.
- O health check descartava sinais quando o APK era instalado diretamente por
  ADB, deixando o preflight bloqueado apesar do provisionamento correto.

**Impacto**

- Backend, Postgres, HMAC, sincronizacao e health check estao operacionais.
- O preflight do servidor passou em nove dos dez gates. O unico bloqueio e o
  comissionamento fisico, que exige responsavel presente e atuacao controlada.
- Nenhuma porta foi acionada durante publicacao, provisionamento, atualizacao
  ou verificacoes desta etapa.

**Arquivos**

- `android/app/src/main/java/com/preddita/entregaslocker/AppUpdateManager.java`
- `docs/KIOSK-V4-PILOTO-CONTROLADO.md`
- `docs/PLANO-IMPLEMENTACAO-MELHORIAS-REDESIGN-2026-07-20.md`
- `docs/RELATORIO-CONSOLIDADO-IMPLEMENTACAO-DEPLOY-2026-07-21.md`
- `docs/HISTORICO-COMPLETO-DE-MELHORIAS.md`
- `docs/CI-RELEASE.md`
- `docs/DEVELOPER-RUNBOOK.md`
- `docs/README.md`
- `docs/UPDATES.md`

**Validacao**

- CI completo, smoke Postgres, contratos Android, build web, Playwright e APK
  debug passaram no workflow `CI`.
- APK release validado por SHA-256, assinatura v2 e mesmo certificado lab da
  candidata anterior.
- `pilot-check` confirmou `2.0.32-lab`, processo ativo e serial presente.
- O updater reportou inicio do app, WebView, credencial e serial saudaveis; o
  estado local permaneceu com as contagens anteriores.

**Referencia:** [release `v2.0.32-lab`](https://github.com/PredditaTi/Locker-Preddita/releases/tag/v2.0.32-lab),
[CI #29890756415](https://github.com/PredditaTi/Locker-Preddita/actions/runs/29890756415)
e [PR #26](https://github.com/PredditaTi/Locker-Preddita/pull/26).

### 2026-07-21 - APK 2.0.31-lab instalado no KS1062

**Base:** release `v2.0.31-lab`, `versionCode 31`, commit de produto
`cb2fc2b16ced77f3f63136e3686ce8e050f48926`

**O que mudou**

- A instalacao antiga `2.0.8-lab`, assinada com chave debug, foi preservada em
  backup e substituida pelo APK lab assinado.
- O estado local foi migrado da origem WebView antiga para a origem segura do
  novo app, sem carregar URL HTTP ou chave de dispositivo no frontend.
- A home do Kiosk V4 foi aberta e os gates locais de versao, processo, camera,
  serial e persistencia foram verificados.

**Por que**

- Assinaturas diferentes impediam atualizacao direta e uma reinstalacao vazia
  perderia o contexto operacional do equipamento.

**Impacto**

- O armario agora executa `2.0.31-lab` e preserva tres destinatarios, 38
  entregas e 18 entradas de auditoria.
- O modo local esta disponivel, mas sincronizacao remota, health check e rollout
  permanecem bloqueados ate o backend HTTPS e o HMAC serem provisionados.

**Arquivos**

- `docs/RELATORIO-CONSOLIDADO-IMPLEMENTACAO-DEPLOY-2026-07-21.md`
- `docs/KIOSK-V4-PILOTO-CONTROLADO.md`
- `docs/PLANO-IMPLEMENTACAO-MELHORIAS-REDESIGN-2026-07-20.md`
- `docs/HISTORICO-COMPLETO-DE-MELHORIAS.md`
- `docs/README.md`
- `docs/UPDATES.md`

**Validacao**

- APK e checksum conferidos antes da instalacao.
- LevelDB relido depois da migracao com as contagens esperadas.
- `pilot-check` confirmou `2.0.31-lab`, processo ativo e serial presente.
- Home V4 conferida visualmente; nenhuma porta foi acionada.

**Referencia:** [release `v2.0.31-lab`](https://github.com/PredditaTi/Locker-Preddita/releases/tag/v2.0.31-lab)
e [PR #26](https://github.com/PredditaTi/Locker-Preddita/pull/26).

### 2026-07-21 - Relatorio consolidado e deploy controlado iniciados

**Base:** produto `2.0.31-lab`, release `v2.0.31-lab`, branch
`codex/kiosk-v4-pilot-readiness`

**O que mudou**

- Foi criado um relatorio unico para recuperacao, seguranca, dados, backend,
  Kiosk V4, release, diagnostico, deploy e rollback.
- O servidor legado e o KS1062 foram identificados por verificacoes somente
  leitura, sem registrar IP, serial, chaves ou dados pessoais no Git.
- O app antigo, seu estado local e o snapshot remoto foram preservados fora do
  repositorio antes da troca de assinatura.

**Por que**

- A implantacao exige uma evidencia auditavel e um caminho de retorno antes de
  substituir o backend ou remover o pacote antigo do equipamento.

**Impacto**

- A equipe possui uma visao consolidada do que foi alterado e do motivo.
- O deploy fica bloqueado de forma explicita enquanto o host HTTPS nao estiver
  autenticado e saudavel; nenhuma porta foi acionada.

**Arquivos**

- `docs/RELATORIO-CONSOLIDADO-IMPLEMENTACAO-DEPLOY-2026-07-21.md`
- `docs/README.md`
- `docs/UPDATES.md`

**Validacao**

- Release, certificado e checksum ja verificados pelo workflow de release.
- Servidor legado confirmou `2.0.8-lab`, schema `6`.
- KS1062 confirmou Android 13, app `2.0.8-lab`, processo ativo e `/dev/ttyS5`.
- Backups foram criados com o app parado e acesso local restrito.

**Referencia:** [PR #26](https://github.com/PredditaTi/Locker-Preddita/pull/26).

### 2026-07-21 - APK assinado 2.0.31-lab publicado

**Base:** tag `v2.0.31-lab`, commit
`cb2fc2b16ced77f3f63136e3686ce8e050f48926`

**O que mudou**

- O workflow `Release APK` gerou e publicou a prerelease imutavel
  `v2.0.31-lab` com o APK e seu arquivo `.sha256`.
- A assinatura APK v2, o signatario lab e o checksum do artefato baixado foram
  conferidos antes de atualizar o gate do piloto.
- O runbook, o plano e a central documental passaram a distinguir release
  assinada concluida de instalacao e validacao fisica ainda pendentes.

**Por que**

- A candidata precisava possuir artefato reproduzivel e verificavel antes de
  ser instalada no primeiro KS1062 do piloto.

**Impacto**

- A equipe pode instalar exatamente o artefato registrado, sem tratar um build
  local ou uma release renomeada como equivalente.
- A release permanece no canal `lab`; comissionamento, bancada, matriz de
  jornadas e observacao autorizada ainda bloqueiam qualquer promocao.

**Arquivos**

- `docs/KIOSK-V4-PILOTO-CONTROLADO.md`
- `docs/CI-RELEASE.md`
- `docs/README.md`
- `docs/PLANO-IMPLEMENTACAO-MELHORIAS-REDESIGN-2026-07-20.md`
- `docs/HISTORICO-COMPLETO-DE-MELHORIAS.md`
- `docs/UPDATES.md`

**Validacao**

- Workflow `Release APK` #29860294336 concluido com sucesso.
- `apksigner` confirmou assinatura v2 e o certificado lab esperado.
- O APK foi baixado da GitHub Release e `shasum -a 256 -c` retornou `OK` para
  `fd79beaa803d5d031c72e5c576b2a1c52cad7f6df35e761793931aae1576b25c`.

**Referencia:** [release `v2.0.31-lab`](https://github.com/PredditaTi/Locker-Preddita/releases/tag/v2.0.31-lab)
e [PR #26](https://github.com/PredditaTi/Locker-Preddita/pull/26).

### 2026-07-21 - Parte 8 preparada para piloto fisico controlado

**Base:** produto `2.0.31-lab`, `versionCode 31`, `schemaVersion 13`, branch
`codex/kiosk-v4-pilot-readiness`

**O que mudou**

- O kiosk passou a medir jornadas sem enviar apartamento, pessoa, PIN, QR,
  porta ou texto livre; o contrato do Edge Agent passou da versao 3 para 4.
- O servidor normaliza uma allowlist, limita 500 amostras por locker e agrega
  conclusao, duracao, ajuda, fallback, erros e modos PIN/QR.
- O Admin ganhou a pagina Piloto, com preflight e amostras sanitizadas.
- Foram criados preflight bloqueante, verificacao ADB somente leitura, testes
  automatizados e runbook de ensaio, parada, recuperacao e consentimento.
- A release candidata foi consolidada em `2.0.31-lab`; referencias a
  `v2.0.25-lab` permanecem como historico e rollback funcional.

**Por que**

- A Parte 8 precisava transformar observacao de campo em evidencia comparavel
  sem ampliar a coleta de dados pessoais.
- Um piloto nao pode comecar com serial, comissionamento, HMAC, versao, update
  ou rollout em estado inadequado.

**Impacto**

- A equipe consegue medir as jornadas e interromper o piloto por criterio
  objetivo.
- O preflight retorna erro quando existe bloqueio e nao aciona nenhuma porta.
- APK assinado, bancada KS1062 e observacao autorizada continuam pendentes; a
  release nao foi promovida a producao.

**Arquivos**

- `docs/KIOSK-V4-PILOTO-CONTROLADO.md`
- `docs/PLANO-IMPLEMENTACAO-MELHORIAS-REDESIGN-2026-07-20.md`
- `docs/ARCHITECTURE.md`
- `docs/API-CONTRACTS-E2E.md`
- `docs/PRIVACY-DATA-LIFECYCLE.md`
- `docs/DEVELOPER-RUNBOOK.md`
- `docs/HISTORICO-COMPLETO-DE-MELHORIAS.md`

**Validacao**

- Testes de metricas, preflight, Edge Agent, smoke, build web e verificacoes
  de documentacao executados; o CI completo, incluindo `assembleDebug`, passou
  em 3min41s.
- Painel Piloto conferido em viewport desktop e movel.
- Testes fisicos permanecem explicitamente pendentes no runbook.

**Referencia:** [PR #26](https://github.com/PredditaTi/Locker-Preddita/pull/26).

### 2026-07-21 - Parte 7 do Kiosk V4 concluida em laboratorio

**Base:** produto `2.0.25-lab`, `versionCode 25`, `schemaVersion 12`, branch
`codex/kiosk-v4-update-health`

**O que mudou**

- O atualizador Android passou a distinguir APK instalado de versao saudavel
  com quatro estados posteriores ao install.
- Startup, WebView, Edge Agent, estado, backup, credencial e serial ganharam
  sinais persistentes, timeout de 45 segundos e janela total de 3 minutos.
- O Edge Agent grava antes do handoff um backup estritamente tecnico e o valida
  no primeiro boot sem incluir moradores, entregas ou credenciais de retirada;
  o contrato do agente passou da versao 2 para 3.
- O Admin mostra sinais, causa, prazo e acao recomendada e pausa novas ofertas
  quando `failed-health` atinge o limite configurado no escopo do locker.
- Recuperacao por versao superior assinada, ADB ou MDM foi documentada sem
  prometer downgrade automatico ou permitir shell remoto.

**Por que**

- A versao anterior marcava `up-to-date` apenas pelo `versionCode`, mesmo sem
  provar que a WebView, o estado e o hardware estavam operacionais.
- Uma release defeituosa precisava deixar de avancar sem remover as validacoes
  criptograficas ou invalidar lockers ja saudaveis.

**Impacto**

- Download, instalacao e saude real agora aparecem como fases distintas.
- Falhas sao deduplicadas por locker/release e podem interromper o rollout.
- O backup de recuperacao nao amplia a superficie de dados pessoais.
- A validacao fisica do APK assinado permanece obrigatoria na Parte 8.

**Arquivos**

- `docs/KIOSK-V4-SAUDE-UPDATE.md`
- `docs/PLANO-IMPLEMENTACAO-MELHORIAS-REDESIGN-2026-07-20.md`
- `docs/ARCHITECTURE.md`
- `docs/API-CONTRACTS-E2E.md`
- `docs/HISTORICO-COMPLETO-DE-MELHORIAS.md`
- `docs/README.md`
- `docs/UPDATES.md`

**Validacao**

- Contratos Java de update e health check passaram.
- Contratos JavaScript de backup e Edge Agent passaram.
- Smoke do Admin validou telemetria, causa, pausa e bloqueio da mesma release.
- Build Vite passou; Gradle local ficou bloqueado apenas pela ausencia do
  Android SDK nesta maquina e permanece coberto pelo CI.
- `git diff --check` e o verificador documental foram executados.

**Referencia:** implementacao de laboratorio da Parte 7; PR sera vinculado apos
publicacao.

### 2026-07-21 - Parte 6 do Kiosk V4 concluida em laboratorio

**Base:** produto `2.0.25-lab`, `versionCode 25`, `schemaVersion 12`, branch
`codex/kiosk-v4-serial-resilience`

**O que mudou**

- O Android passou a ter uma fila nativa unica e limitada para o barramento,
  com no maximo uma escrita fisica em voo.
- Pedidos e respostas agora sao correlacionados por `executionId`, comando,
  board, canal, tipo e BCC.
- Somente leitura admite uma segunda tentativa; atuacao incerta nao e repetida
  e bloqueia o canal ate reconciliacao pelo sensor.
- Falha de I/O tenta uma reabertura com backoff e deixa driver e fila
  degradados quando nao recupera.
- Edge Agent e console receberam somente metricas sanitizadas de fila, espera,
  timeout, ruido, falhas e reconexoes.
- Uma pagina especializada registra arquitetura, politica, testes, limites e o
  checklist fisico da Parte 6.

**Por que**

- A fila JavaScript protegia o fluxo atual, mas chamadas nativas concorrentes
  ainda podiam criar varias threads, sobrepor escritas e substituir a unica
  expectativa do parser.
- Repetir uma abertura depois de timeout poderia acionar a mesma trava duas
  vezes; o sensor e o diario precisam resolver essa incerteza.

**Impacto**

- Toda escrita da bridge, inclusive a API legada, atravessa o mesmo worker.
- Leituras toleram uma perda transitoria sem aplicar retry a atuacoes.
- Suporte consegue observar degradacao sem receber payload bruto, identificador
  de execucao ou detalhe interno do Android.
- A implementacao esta concluida em laboratorio; a aprovacao para piloto ainda
  depende do gate no KS1062 e das duas polaridades de sensor.

**Arquivos**

- `docs/KIOSK-V4-RESILIENCIA-SERIAL.md`
- `docs/PLANO-IMPLEMENTACAO-MELHORIAS-REDESIGN-2026-07-20.md`
- `docs/ARCHITECTURE.md`
- `android/app/src/main/java/com/preddita/entregaslocker/SerialCommandCoordinator.java`
- `android/app/src/main/java/com/preddita/entregaslocker/MainActivity.java`
- `web/src/serial.js`
- `web/src/edgeAgent.js`
- `web/src/DiagnosticsView.jsx`
- `scripts/SerialCommandCoordinatorTest.java`

**Validacao**

- Contratos Java provaram exclusao mutua, fila limitada, correlacao, timeout,
  retry de leitura, uma reabertura, degradacao e atuacao desconhecida.
- Parser nativo cobriu fragmentacao, eco, frames colados, ruido, BCC e metricas
  de descarte.
- Contratos JavaScript validaram callback por `executionId`, propagacao do
  resultado desconhecido e sanitizacao da telemetria.
- Build web e provas fechada-aberta-fechada existentes permaneceram verdes.

**Referencia:** Parte 6 do plano Kiosk V4; PR sera associado apos publicacao.

### 2026-07-21 - Parte 5 do Kiosk V4 concluida

**Base:** produto `2.0.25-lab`, `versionCode 25`, `schemaVersion 12`, branch
`codex/kiosk-v4-diagnostics`

**O que mudou**

- O console tecnico passou a exigir PIN derivado e provisionado no Android,
  aplicar lockout e expirar a sessao em cinco minutos.
- Seis abas reúnem status, portas, conectividade, camera, tela e update por uma
  bridge com allowlist e limites nativos.
- Testes de porta, ajustes e acesso agora possuem confirmacao e auditoria com
  ator, locker, horario e resultado.
- Uma pagina especializada e tres capturas documentam operacao, seguranca,
  testes e gate de campo.

**Por que**

- O suporte local precisava de observabilidade sem manter o fallback sem PIN
  nem introduzir terminal, shell ou comandos arbitrarios no WebView.

**Impacto**

- URL nao abre o console e ausencia de credencial falha de forma fechada.
- Brilho, volume e persistencia sao validados na pagina e no Android.
- O build web e os testes passaram; o build Android local depende da instalacao
  do SDK e a validacao fisica continua obrigatoria antes do piloto.

**Arquivos**

- `docs/KIOSK-V4-CONSOLE-TECNICO.md`
- `docs/assets/kiosk-v4-diagnostics/`
- `web/src/useDiagnosticGate.js`
- `web/src/diagnosticBridge.js`
- `web/src/DiagnosticsView.jsx`
- `web/src/CommissioningPanel.jsx`
- `android/app/src/main/java/com/preddita/entregaslocker/DiagnosticControlContract.java`
- `android/app/src/main/java/com/preddita/entregaslocker/DiagnosticCredentialStore.java`
- `android/app/src/main/java/com/preddita/entregaslocker/MainActivity.java`
- `web/e2e/kiosk-diagnostics.spec.js`

**Validacao**

- Contratos Java e JavaScript do console aprovados.
- Quatorze cenarios dedicados passaram; seis repeticoes fisicas foram ignoradas
  intencionalmente fora do viewport de referencia.
- A suite Playwright completa terminou com 45 aprovacoes e 27 skips condicionais.
- Cinco cenarios de layout passaram e tres capturas tiveram overflow zero.
- Build Vite de producao concluido; Gradle local bloqueado por ausencia do SDK.

**Referencia:** documentacao da Parte 5 na branch `codex/kiosk-v4-diagnostics`.

### 2026-07-20 - Parte 4 do Kiosk V4 concluida

**Base:** produto `2.0.25-lab`, `versionCode 25`, `schemaVersion 12`, branch
`codex/kiosk-v4-audio`

**O que mudou**

- Foram integrados 12 prompts fixos locais, controle mudo/volume/repeticao e
  selecao por prioridade nas jornadas publicas.
- Lista fechada, hashes e testes impedem TTS dinamico, repeticao por rerender e
  fala de dados pessoais.
- Duas capturas e uma pagina especializada registram interface, origem,
  limites e reproducao da Parte 4.

**Por que**

- A orientacao precisava ser opcional, offline e segura para uma area comum,
  sem ampliar o bridge Android nem transformar credenciais em fala.

**Impacto**

- O kiosk inicia mudo e continua totalmente operavel sem som.
- O bundle recebe `450.550 bytes` de audio; versao, schema, API e regras de
  porta nao mudam.
- Os arquivos atuais permanecem restritos a laboratorio ate confirmar direito
  de distribuicao da voz usada ou substitui-los por gravacoes liberadas.

**Arquivos**

- `docs/KIOSK-V4-AUDIO-ACESSIVEL.md`
- `docs/assets/kiosk-v4-audio/`
- `web/src/audioGuidance.js`
- `web/src/assets/audio/`
- `web/src/publicKioskUi.jsx`
- `web/src/kioskTheme.css`
- `web/e2e/kiosk-audio.spec.js`
- `scripts/audio-guidance-test.mjs`

**Validacao**

- Politica, privacidade e SHA-256 dos 12 prompts aprovados.
- Oito cenarios dedicados passaram nos quatro viewports Playwright.
- Duas capturas inspecionadas com zero erro de console e sem overflow.
- Build Vite de producao concluido com todos os audios no pacote Android.

**Referencia:** documentacao da Parte 4 na branch `codex/kiosk-v4-audio`.

### 2026-07-20 - Parte 3 do Kiosk V4 concluida

**Base:** produto `2.0.25-lab`, `versionCode 25`, `schemaVersion 12`, branch
`codex/kiosk-v4-journeys`

**O que mudou**

- As jornadas reais de entrega, retirada, espera, sucesso e excecao passaram
  para a linguagem visual V4 aprovada.
- PIN e QR foram unificados em um controle segmentado; o QR ganhou prova E2E
  pelo decodificador real com camera simulada.
- Fallback grande e cancelamento passaram a exigir fechamento comprovado da
  porta pequena antes de liberar ou apagar a reserva.
- JSX e CSS publicos V3 duplicados foram removidos.
- Foram geradas 13 referencias reais em `1024x600`, com gerador e metricas.

**Por que**

- Era necessario concluir o redesign sem enfraquecer as garantias fisicas,
  tornar erros recuperaveis e impedir cancelamento inseguro com porta aberta.

**Impacto**

- O fluxo publico inteiro usa agora o Kiosk V4; o Admin mantem a composicao
  operacional existente.
- O bundle ficou menor que na fundacao V4 apesar das novas jornadas.
- Versao, schema, protocolo e modelo persistido nao mudaram.

**Arquivos**

- `docs/KIOSK-V4-JORNADAS-PUBLICAS.md`
- `docs/assets/kiosk-v4-journeys/`
- `web/src/publicKioskUi.jsx`
- `web/src/kioskTheme.css`
- `web/src/App.jsx`
- `web/e2e/kiosk-flow.spec.js`
- `web/e2e/kiosk-interactions.spec.js`
- `web/e2e/capture-kiosk-v4-journeys.mjs`
- `docs/PLANO-IMPLEMENTACAO-MELHORIAS-REDESIGN-2026-07-20.md`
- `docs/API-CONTRACTS-E2E.md`
- `docs/DEVELOPER-RUNBOOK.md`

**Validacao**

- Entrega pequena, porta grande, retirada por PIN e QR e limpeza de credenciais
  cobertas no E2E.
- Layout auditado em `1024x600`, `1280x800`, `800x480` e `390x844`.
- Treze capturas inspecionadas e geradas com zero erro de console.
- Bundle medido em `953.710 bytes`, ou `319.470 bytes` gzip.

**Referencia:** documentacao da Parte 3 na branch `codex/kiosk-v4-journeys`.

### 2026-07-20 - Parte 2 do Kiosk V4 implementada

**Base:** produto `2.0.25-lab`, `versionCode 25`, `schemaVersion 12`, branch
`codex/kiosk-v4-foundation`

**O que mudou**

- Criada a fundacao visual de alto contraste e a nova home full-screen.
- Adicionadas barra superior, ajuda, estados de controle e duas acoes com alvo
  minimo de 64 px.
- Empacotadas localmente a fonte Atkinson Hyperlegible Next e os icones Lucide,
  com suas licencas no repositorio.
- Criados cinco prototipos navegaveis sem Edge Agent ou hardware para aprovacao
  de inicio, apartamento, porta, PIN e sucesso.
- Geradas quatro referencias responsivas da home e cinco referencias de produto
  em `1024x600`.
- Adicionados testes de contraste WCAG AA, toque, navegacao, scroll e console.

**Por que**

- A Parte 3 precisa de uma linguagem visual aprovada antes de substituir as
  jornadas reais e aproximar mudanca de tela de regras fisicas sensiveis.
- Fonte, marca e icones devem permanecer disponiveis quando o locker estiver
  sem internet.

**Impacto**

- A home V4 passa a ser a entrada do fluxo publico; as etapas seguintes ainda
  usam a implementacao funcional V3.
- Os prototipos ficam disponiveis apenas por query de desenvolvimento e nao
  executam side effects.
- O bundle gzip passou de `260.488` para `320.235 bytes`, incluindo `53.088
  bytes` de fontes WOFF2 locais.
- Nenhuma versao, schema, protocolo ou regra de porta mudou.

**Arquivos**

- `docs/KIOSK-V4-FUNDACAO-VISUAL.md`
- `docs/assets/kiosk-v4-foundation/`
- `docs/HISTORICO-COMPLETO-DE-MELHORIAS.md`
- `web/src/kioskTheme.css`
- `web/src/kioskIcons.jsx`
- `web/src/kioskPrototypeUi.jsx`
- `web/src/publicKioskUi.jsx`
- `web/e2e/kiosk-v4-home.spec.js`
- `web/e2e/kiosk-v4-prototype.spec.js`
- `web/licenses/`
- `docs/PLANO-IMPLEMENTACAO-MELHORIAS-REDESIGN-2026-07-20.md`

**Validacao**

- Home aprovada tecnicamente nos viewports `1024x600`, `1280x800`, `800x480`
  e `390x844`, sem overflow e com zero erro de console.
- Cinco prototipos navegados automaticamente em `1024x600` com controles de
  pelo menos 64 px.
- Contraste dos textos principais validado automaticamente nos quatro projetos
  Playwright.
- Nove capturas inspecionadas visualmente; aprovacao de produto ainda e o gate
  para iniciar a Parte 3.

**Referencia:** documentacao da Parte 2 na branch `codex/kiosk-v4-foundation`.

### 2026-07-20 - Parte 1 do Kiosk V4 concluida

**Base:** produto `2.0.25-lab`, `versionCode 25`, `schemaVersion 12`, branch
`codex/kiosk-v4-baseline`

**O que mudou**

- Capturados nove estados visuais da V3 em `1024x600`, com gerador
  reproduzivel e metricas em JSON.
- Adicionados quatro projetos Playwright e auditoria de overflow, recorte,
  sobreposicao, foco, nomes acessiveis e console.
- Cobertos teclado, retorno, cancelamento, timeout e `Nova entrega`.
- Extraida uma fixture RS-485 compartilhada pelos testes E2E.
- Corrigidos cortes reais em `800x480` e composicao/scroll em `390x844`.
- Confirmado o release `v2.0.25-lab`, APK e SHA-256 como rollback.

**Por que**

- O redesign V4 precisa de uma referencia objetiva para distinguir evolucao
  visual de regressao funcional.
- A primeira matriz revelou controles inacessiveis em telas baixas e retrato,
  que foram corrigidos antes da captura definitiva.

**Impacto**

- A Parte 2 pode alterar a linguagem visual com comparacao automatica e
  evidencias reproduziveis.
- Nenhuma versao, schema, protocolo ou regra de conclusao de porta mudou.

**Arquivos**

- `docs/KIOSK-V3-BASELINE.md`
- `docs/assets/kiosk-v3-baseline/`
- `web/e2e/`
- `web/playwright.config.js`
- `web/src/app.css`
- `web/package.json`
- `docs/PLANO-IMPLEMENTACAO-MELHORIAS-REDESIGN-2026-07-20.md`
- `docs/API-CONTRACTS-E2E.md`
- `docs/DEVELOPER-RUNBOOK.md`

**Validacao**

- Jornada e auditoria visual aprovadas nos quatro viewports.
- Contratos de interacao aprovados com relogio virtual para o timeout.
- Bundle medido em `875.327 bytes`, ou `260.488 bytes` gzip.
- Primeira tela pronta em `302,2 ms` no servidor local e zero erros de console.
- Screenshots inspecionados visualmente e release de rollback consultado pelo
  GitHub CLI.

**Referencia:** [release v2.0.25-lab](https://github.com/PredditaTi/Locker-Preddita/releases/tag/v2.0.25-lab).

### 2026-07-20 - Plano de melhorias e redesign do Kiosk V4

**Base:** produto `2.0.25-lab`, `versionCode 25`, `schemaVersion 12`, branch
`codex/documentation-hub`

**O que mudou**

- Criado um plano de oito partes para transformar a analise comparativa em
  implementacao incremental.
- Definida uma identidade original de alto contraste para o Kiosk V4,
  inspirada na simplicidade do app analisado sem copiar codigo ou assets.
- Mapeadas telas de inicio, entrega, retirada, espera, sucesso, erro e
  cancelamento.
- Planejadas orientacao sonora, console tecnico autenticado, resiliencia serial
  e health check seguro de atualizacao.
- Separados recursos obrigatorios de itens condicionais como blocos, tamanho
  `GG`, transportadoras, hotspot, video e WhatsApp.
- Registrados arquivos previstos, criterios de aceite, testes, riscos,
  sequencia de PRs e releases candidatas.
- O guia da V3 passou a apontar para o novo ciclo V4.

**Por que**

- As ideias aproveitaveis precisavam de ordem, fronteiras e criterios para nao
  misturar redesign com alteracoes de hardware de alto risco.
- O frontend atual usa uma linguagem clara, mas ainda se parece com um painel
  de cards; o objetivo agora e uma experiencia de autoatendimento full-screen,
  mais proxima do visual aprovado pelo responsavel do produto.

**Impacto**

- As proximas melhorias podem ser executadas em sete PRs principais, com
  rollback e validacao por etapa.
- A Parte 1 cria a protecao de regressao antes de qualquer mudanca visual.
- Nenhum codigo funcional, versao, contrato ou schema foi alterado nesta
  atualizacao.

**Arquivos**

- `docs/PLANO-IMPLEMENTACAO-MELHORIAS-REDESIGN-2026-07-20.md`
- `docs/ANALISE-COMPARATIVA-VEXPRESS-PENDRIVE.md`
- `docs/PASSO-A-PASSO-REDESIGN-PUBLICO.md`
- `docs/README.md`
- `docs/UPDATES.md`

**Validacao**

- Plano conferido contra os componentes React, CSS, Edge Agent, bridge Android,
  atualizador, diagnostico e testes E2E existentes.
- Direcao visual confirmada por leitura estatica dos estilos do app analisado.
- Escopo revisado para preservar HMAC, Keystore, idempotencia, prova fisica,
  privacidade e verificacao criptografica de updates.
- Links locais e integridade documental validados pelo verificador do projeto.

**Referencia:** derivado da analise comparativa local de 20 de julho de 2026.

### 2026-07-20 - Analise comparativa de app de locker recuperado

**Base:** produto `2.0.25-lab`, `versionCode 25`, `schemaVersion 12`, branch
`codex/documentation-hub`

**O que mudou**

- Criado um relatorio tecnico sanitizado do material local identificado como
  VExpress.
- Documentadas arquitetura Linux ARM64, interfaces React, Node-RED, banco,
  servicos de camera e voz, operacao remota, fluxos, dados e protocolo serial.
- Classificados riscos de seguranca, privacidade, atualizacao e manutencao sem
  registrar credenciais, enderecos ou dados pessoais encontrados.
- Comparadas as capacidades observadas com a arquitetura atual da PREDDITA.
- Priorizadas ideias de voz, diagnostico, resiliencia serial e health checks de
  update, com criterios para reimplementacao independente.
- A central da documentacao passou a apontar para o novo relatorio.

**Por que**

- O material de um produto semelhante permite aprender com recursos e falhas
  reais sem incorporar codigo de terceiros.
- As conclusoes precisavam ficar separadas dos arquivos brutos e disponiveis
  para orientar os proximos ciclos do produto.

**Impacto**

- Produto e engenharia passam a ter uma referencia comparativa baseada em
  evidencia estatica local.
- O backlog distingue conceitos aproveitaveis de implementacoes que nao devem
  ser reproduzidas.
- Nenhum codigo funcional, contrato, schema, versao ou dado de producao foi
  alterado.

**Arquivos**

- `docs/ANALISE-COMPARATIVA-VEXPRESS-PENDRIVE.md`
- `docs/README.md`
- `docs/UPDATES.md`

**Validacao**

- Inventario, codigo, configuracoes, servicos, rotas e fluxos Node-RED foram
  conferidos estaticamente sem iniciar o software analisado.
- Evidencia de autorizacao foi rastreada em 76 entradas HTTP do Node-RED.
- Buscas de ciclo de vida confirmaram somente exclusoes manuais pontuais, sem
  politica automatica de retencao observavel.
- O material bruto permaneceu fora do repositorio e o relatorio foi revisado
  para nao conter segredos, dados pessoais ou codigo proprietario.

**Referencia:** material local analisado em 20 de julho de 2026; sem publicacao
do conteudo original.

### 2026-07-16 - Central e historico completo do projeto

**Base:** produto `2.0.25-lab`, `versionCode 25`, `schemaVersion 12`, commit de
produto `014709d`

**O que mudou**

- Criada esta pagina cronologica de atualizacoes.
- Criada `docs/README.md` como portal navegavel da documentacao no GitHub.
- Criado um historico completo das dezoito etapas tecnicas executadas desde a
  recuperacao do projeto.
- O README principal passou a apontar para a central e para esta pagina.
- Requisitos foram corrigidos para Node.js 20.19+ e JDK 17.
- Comandos ADB foram atualizados para o pacote Android atual
  `com.preddita.entregaslocker`.
- Guia e script de diagnostico foram alinhados com `/dev/ttyS5`; outra porta
  pode ser informada por `PREDDITA_SERIAL_PORT`.
- O runbook passou a explicar a diferenca entre JSON invalido e estado valido
  sanitizado pela politica de privacidade.
- O contrato E2E passou a registrar que PIN, token, QR e codigo externo
  permanecem apagados depois do reload.
- Notas do KS1062 e instrucoes locais do Admin Online foram alinhadas com a
  serial e a estrutura atuais do repositorio.
- Adicionado checklist de pull request para lembrar o registro de atualizacoes.
- Adicionado verificador automatico de links e da obrigatoriedade de atualizar
  esta pagina; a verificacao agora faz parte do CI.

**Por que**

- A explicacao das melhorias estava distribuida entre commits e documentos.
- Alguns comandos do README ainda descreviam pacote, runtime e porta serial de
  etapas antigas.
- Nao havia um lugar unico para acompanhar futuras revisoes documentais.

**Impacto**

- Abrir `docs/` no GitHub agora apresenta uma entrada unica para todo o projeto.
- Novos desenvolvedores possuem rotas de leitura por atividade.
- Equipe pode identificar atualizacoes sem reconstruir o historico Git.
- Diagnostico serial aceita variantes de hardware sem editar o script.
- Nenhum contrato de API, schema ou versao funcional foi alterado.

**Arquivos**

- `README.md`
- `NOTES-KS1062.md`
- `admin-online/README.md`
- `docs/README.md`
- `docs/UPDATES.md`
- `docs/HISTORICO-COMPLETO-DE-MELHORIAS.md`
- `docs/DEVELOPER-RUNBOOK.md`
- `docs/API-CONTRACTS-E2E.md`
- `scripts/deploy.sh`
- `.github/pull_request_template.md`
- `.github/workflows/ci.yml`
- `scripts/check-documentation.mjs`

**Validacao**

- Historico e titulos dos PRs #1 a #17 conferidos no GitHub.
- Links relativos do historico verificados localmente.
- Verificador executado sobre todos os arquivos Markdown do repositorio.
- Sintaxe de `scripts/deploy.sh` validada com `bash -n`.
- Entrada serial invalida confirmada como bloqueada antes do ADB.
- `git diff --check` executado sem erros.

**Referencia:** base funcional [v2.0.25-lab](https://github.com/PredditaTi/Locker-Preddita/releases/tag/v2.0.25-lab)
