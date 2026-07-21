# Historico completo de alteracoes e melhorias

## Escopo deste documento

Este relatorio consolida as alteracoes relevantes feitas no PREDDITA Locker
desde a recuperacao do codigo ate a versao atual `2.0.25-lab`. O objetivo e
permitir que outra pessoa entenda:

- o que foi alterado;
- por que a alteracao foi necessaria;
- qual risco ou limitacao foi tratado;
- qual foi o impacto pratico na operacao;
- como a mudanca foi validada;
- o que ainda depende de piloto, hardware ou decisao organizacional.

O documento cobre comportamento, arquitetura, seguranca, dados, operacao,
testes e entrega. Alteracoes mecanicas de arquivos gerados, lockfiles e bundles
compilados sao citadas pelo efeito que produzem, sem listar cada linha gerada.

**Estado de referencia:** `2.0.25-lab`, `versionCode 25`, `schemaVersion 12`,
commit `014709d`, publicado em 16 de julho de 2026.

## Resumo executivo

| Area | Situacao recuperada | Situacao em `2.0.25-lab` | Motivo principal |
| --- | --- | --- | --- |
| Codigo-fonte | Misturado com artefatos e dados da maquina anterior | Repositorio limpo, reproduzivel e versionado | Permitir continuidade e auditoria |
| Operacao offline | Fila monolitica vulneravel a perda ou corrupcao | Diario duravel por evento e recuperacao idempotente | Nao perder entregas sem internet |
| Comandos remotos | Polling e confirmacao simples | Lease, ACK, `executionId`, diario local e conclusao transacional | Evitar abertura dupla ou resultado falso |
| Autenticacao do locker | Chave exposta no bundle/browser | HMAC com nonce e chave nao exportavel no Android Keystore | Impedir falsificacao e vazamento da credencial |
| Administracao | Token fixo informado pelo navegador | Login, cookie HttpOnly, CSRF, papeis, escopo e MFA | Reduzir invasao e abuso de privilegios |
| Portas | Confirmacao logica insuficiente | Prova fisica fechada-aberta-fechada por canal | Nao concluir operacao sem evidencia do sensor |
| Instalacao | Mapa fisico presumido | Assistente de comissionamento por porta | Adaptar software ao hardware real |
| Persistencia cloud | `state.json` monolitico | Postgres normalizado, transacoes e migracao automatica | Concorrencia, consulta e recuperacao confiaveis |
| Observabilidade | Logs informais | Logs estruturados, correlacao, filtros, CSV e retencao | Diagnostico remoto e auditoria operacional |
| Arquitetura do kiosk | UI ligada diretamente a serial e rede | Kiosk UI separada do contrato Edge Agent | Testabilidade e evolucao do edge |
| Experiencia publica | Composicao V3 baseada em shell e cards | Jornadas V4 full-screen integradas, responsivas e cobertas por E2E | Leitura a distancia, toque e operacao fisica segura |
| Atualizacao | ADB/manual | Manifesto remoto, rollout e validacao criptografica | Atualizar frota com controle e rastreabilidade |
| Entrega de comandos | Polling frequente | Wake-up MQTT QoS 1 com fallback HTTP | Menor latencia sem perder a fonte de verdade |
| Qualidade | Testes pontuais | Contratos reais, E2E Playwright, smokes e CI | Detectar regressao entre UI, API e Android |
| Privacidade | Retencao indefinida e credenciais historicas | Expurgo, anonimização, exportacao e eliminacao controlada | Minimizar dados e apoiar direitos do titular |

## Principios usados nas decisoes

1. **Local-first:** deposito e retirada precisam continuar sem internet.
2. **Falhar de forma fechada:** incerteza sobre porta, assinatura ou estado nao
   pode ser tratada como sucesso.
3. **Idempotencia:** reenvio por queda de rede nao pode duplicar abertura,
   notificacao ou mudanca de estado.
4. **Menor privilegio:** navegador, locker e operador recebem somente o acesso
   necessario ao seu papel e ao seu escopo.
5. **Segredo fora do JavaScript:** credenciais de dispositivo e administracao
   nao ficam no bundle, URL ou `localStorage`.
6. **Fonte de verdade persistente:** MQTT apenas acorda o locker; API e banco
   continuam decidindo o estado.
7. **Evidencia fisica antes da regra de negocio:** liberar uma porta depende de
   leitura individual e atual do sensor correto.
8. **Migracao progressiva:** dados recuperados continuam legiveis enquanto os
   formatos novos sao adotados com backup e backfill.

## Linha do tempo detalhada

### 1. Recuperacao e endurecimento inicial - base `2.0.9-lab`

**O que mudou**

- O codigo recuperado foi promovido para uma arvore limpa, com dependencias,
  builds, arquivos temporarios e dados sensiveis fora do Git.
- Duas copias recuperadas de `state.json` foram preservadas em `recovery/` com
  checksums SHA-256, mantendo evidencia do material original.
- A leitura de estado passou a aceitar BOM UTF-8 e a interromper a inicializacao
  operacional quando o JSON e invalido. O servidor nao inventa dados de exemplo
  sobre um arquivo que nao conseguiu interpretar.
- Endereco de servidor e chave de dispositivo deixaram de ser embutidos no
  bundle web. Build de producao passou a exigir endpoint HTTPS explicito.
- O agente de teste deixou de chamar o servidor antigo por padrao; URL passou a
  ser obrigatoria e HTTP ficou limitado a loopback.
- A WebView passou a servir assets por `appassets.androidplatform.net`, com CSP,
  navegacao restrita, acesso universal a arquivos desativado e cleartext apenas
  em debug.
- Frames RS-485 passaram a exigir exatamente cinco bytes hexadecimais e BCC
  valido antes de chegar a regra de negocio.
- Release Android deixou de reutilizar assinatura de debug e passou a exigir
  keystore externo.
- Rate limits foram movidos para antes da autenticacao, proxy confiavel ficou
  opt-in e configuracoes inseguras passaram a bloquear producao.
- Dependencias de producao foram atualizadas e auditadas.

**Por que**

O projeto precisava primeiro se tornar reproduzivel e confiavel. Continuar em
cima de arquivos misturados, endpoints antigos e credenciais embutidas criaria
risco de perda de dados, acesso indevido e acionamento do equipamento errado.

**Impacto e validacao**

- A recuperacao preserva o original e nao mascara corrupcao.
- Build de producao agora falha cedo quando falta configuracao segura.
- Testes cobrem BOM, JSON truncado, BCC e configuracao de release.
- O codigo recuperado passou a ter uma base versionada para todas as etapas
  seguintes.

### 2. Diario offline e execucao remota duravel - `2.0.10-lab`, PR #1

**O que mudou**

- A fila offline unica foi substituida por um registro independente para cada
  evento sob o prefixo `preddita_device_event_journal_v2:`.
- A migracao da fila antiga so a remove depois de gravar todos os eventos
  validos. Um registro corrompido nao torna os demais ilegíveis.
- O evento so e removido quando o servidor devolve o ID como aceito.
- Comandos remotos ganharam estados `pending`, `leased`, `executing`,
  `completed` e `failed`.
- Antes de tocar a serial, o locker persiste `commandId`, `leaseId` e
  `executionId`; ACK passou a ser obrigatorio.
- Reinicio com resultado fisico desconhecido bloqueia reexecucao automatica e
  exige verificacao, em vez de abrir a mesma porta novamente.
- O parser Android passou a acumular chunks, separar frames colados, ignorar
  ruido e validar BCC. A camada JavaScript correlaciona comando, placa e canal.
- O servidor serializa mutacoes do locker e devolve leases expirados para a
  fila sem duplicar o efeito final.

**Por que**

Rede movel, energia e processo Android podem falhar em qualquer ponto. Sem
diario e idempotencia, um retry poderia perder um evento ou abrir uma porta
duas vezes.

**Impacto e validacao**

- Entregas offline sobrevivem a reload e corrupcao localizada.
- Retransmissoes de rede sao seguras.
- Testes dedicados exercitam diario de eventos, diario de comandos, parser
  RS-485 e reentrega de lease.

### 3. CI e releases assinados - PR #2

**O que mudou**

- GitHub Actions passou a executar verificacao da aplicacao, testes, auditoria
  de dependencias e build Android.
- O workflow de release passou a receber material de assinatura por secrets,
  gerar APK assinado, checksum SHA-256 e GitHub Release imutavel.
- O processo e os secrets necessarios foram registrados em
  [CI-RELEASE.md](CI-RELEASE.md).

**Por que**

Uma compilacao manual nao prova que outra maquina reproduz o APK nem garante
que o binario publicado corresponde ao codigo revisado.

**Impacto e validacao**

- Cada PR recebe verificacao automatica.
- Releases podem ser conferidos pelo checksum e pela assinatura Android.
- A tag `v2.0.10-lab` e a primeira tag preservada no historico atual.

### 4. Autenticacao HMAC do dispositivo - `2.0.11-lab`, PR #3

**O que mudou**

- Rotas do dispositivo passaram a exigir HMAC-SHA256 sobre metodo, caminho,
  `lockerId`, timestamp, nonce e hash do corpo.
- Assinatura alterada, timestamp expirado e replay de nonce passaram a ser
  recusados.
- Producao aceita apenas HMAC. O modo `dual` ficou disponivel para migracao em
  laboratorio, sem fallback quando uma assinatura HMAC invalida e enviada.
- Foi criado um contrato automatizado para servidor e dispositivo.

**Por que**

Uma chave enviada como token simples poderia ser copiada e reutilizada. HMAC
prova integridade e autenticidade de cada requisicao sem transmitir a chave.

**Impacto e validacao**

- Captura de uma requisicao nao permite replay posterior.
- Alterar corpo, rota ou locker invalida a assinatura.
- Esta versao existiu como etapa de codigo; o repositorio atual nao conserva
  uma tag `v2.0.11-lab`, pois a tag seguinte publicada foi `v2.0.12-lab`.

### 5. Credencial no Android Keystore - `2.0.12-lab`, PR #4

**O que mudou**

- O APK generico deixou de carregar chave de dispositivo.
- Um dialogo nativo passou a provisionar URL, `lockerId` e chave no equipamento.
- A chave e importada como material nao exportavel no Android Keystore.
- A WebView solicita assinaturas ao bridge nativo e nunca recebe a chave.
- O valor legado em `localStorage` e removido.
- CI e Vite recusam `VITE_PREDDITA_DEVICE_KEY` para impedir regressao.

**Por que**

Mesmo com HMAC, guardar a chave em JavaScript permitiria extracao via DevTools,
bundle ou armazenamento local.

**Impacto e validacao**

- Cada locker e provisionado individualmente.
- Comprometimento da UI nao exporta a chave de longa duracao.
- Testes nativos validam provisionamento, assinatura e ausencia de segredo no
  bundle.

### 6. Sessoes administrativas, CSRF e papeis - `2.0.13-lab`, PR #5

**O que mudou**

- Token fixo no browser foi substituido por login com senha derivada por
  `scrypt` e sessao opaca.
- Cookie passou a ser `HttpOnly`, `SameSite=Strict` e `Secure` em producao.
- Mutacoes exigem token CSRF.
- Auditoria usa o ator autenticado pelo servidor, sem confiar em
  `requestedBy` enviado pelo cliente.
- Papeis `sindico`, `operator`, `suporte` e `super_admin` passaram a ser
  aplicados no backend.
- Usuario tambem ficou restrito por tenant e locker.
- Um gerador via stdin evita colocar senha em argumento ou historico do shell.

**Por que**

Esconder botoes na interface nao protege endpoints. Autorizacao precisava ser
centralizada no servidor, com sessao resistente a leitura por JavaScript.

**Impacto e validacao**

- Acesso administrativo passou a ter identidade e escopo auditaveis.
- CSRF, cookie e matriz de permissoes sao exercitados pelo smoke test.

### 7. Confirmacao fisica da porta - `2.0.14-lab`, PR #6

**O que mudou**

- Deposito e retirada passaram a exigir leituras individuais, atuais e com BCC
  valido no ciclo fechada-aberta-fechada do mesmo canal.
- Leituras antigas, em bloco, ambiguas, sem transicao ou de outro canal sao
  recusadas.
- Retirada nao muda diretamente para `collected`: usa `pickup_opened` enquanto
  aguarda o fechamento.
- A porta so e liberada depois da prova final; o servidor recusa
  `releasedDoor` sem evidencia temporal.
- Perfis `zeroOpen` e `zeroClosed` suportam as duas polaridades observadas.

**Por que**

Receber o comando serial nao significa que a porta abriu, que o usuario a
fechou ou que o sensor lido pertence a ela.

**Impacto e validacao**

- O estado operacional passa a refletir o hardware confirmado.
- Testes cobrem polaridades, timeout, sensor stale, canal incorreto e leitura em
  bloco.

### 8. Assistente de comissionamento - `2.0.15-lab`, PR #7

**O que mudou**

- Foi criado um fluxo tecnico protegido que valida um canal por vez.
- O assistente confirma estado inicial fechado, identifica polaridade, aplica
  tempo de acionamento, observa abertura e espera fechamento final.
- Cada canal recebe tamanho `P`, `M` ou `G`; esse mapa passa a orientar kiosk e
  painel.
- Board, quantidade, polaridade, tempo, mapa e provas ficam persistidos.
- Alteracao de qualquer parametro fisico critico invalida o comissionamento.
- Heartbeat passou a informar status e data da configuracao.

**Por que**

Numero de portas, chicote, polaridade e tempo de pulso variam entre instalacoes.
Supor um mapa fixo poderia abrir o compartimento errado.

**Impacto e validacao**

- O software passa a conhecer a montagem real antes de operar.
- O teste de comissionamento valida conclusao integral e invalidacao por
  mudanca critica.

### 9. Sessoes persistentes no Postgres - `2.0.16-lab`, PR #8

**O que mudou**

- Usuarios foram movidos para `preddita_admin_users` e sessoes para
  `preddita_admin_sessions`.
- O banco guarda apenas SHA-256 do token de sessao.
- Restart preserva sessoes validas; logout e revogacao continuam validos depois
  do restart.
- Rotacao de senha invalida sessoes anteriores de forma duravel.

**Por que**

Sessoes apenas em memoria quebram em reinicio e nao funcionam corretamente com
mais de uma instancia do servidor.

**Impacto e validacao**

- A autenticacao ficou compativel com operacao persistente e replicada.
- O smoke Postgres reinicia o servidor e verifica restauracao, logout e
  rotacao.

### 10. MFA para perfis privilegiados - `2.0.17-lab`, PR #9

**O que mudou**

- `super_admin` e `suporte` passaram a exigir TOTP.
- Cadastro oferece QR e chave manual, alem de dez codigos de recuperacao de uso
  unico.
- Segredo TOTP e cifrado com AES-256-GCM usando chave externa.
- Desafios guardam somente hash, expiram em cinco minutos e limitam tentativas.
- Reuso de TOTP e consumo concorrente do mesmo codigo de recuperacao sao
  bloqueados transacionalmente.
- Painel ganhou fluxo responsivo de cadastro e desafio MFA.

**Por que**

Perfis de suporte e administracao geral podem operar varios lockers. Uma senha
comprometida nao deve ser suficiente para assumir esse privilegio.

**Impacto e validacao**

- Login privilegiado ganhou um segundo fator e caminho de recuperacao
  controlado.
- Testes cobrem replay, expiracao, tentativas e consumo unico.

### 11. Dados operacionais normalizados - `2.0.18-lab`, PR #10

**O que mudou**

- Moradores, entregas, comandos e auditoria sairam do JSONB principal para
  tabelas relacionais por `tenant_id`, `locker_id` e ID.
- Colunas pesquisaveis e indices foram adicionados, preservando payload
  completo para compatibilidade.
- Snapshot central e entidades passam a ser gravados na mesma transacao.
- Leitura reidrata o mesmo contrato de API usado anteriormente.
- Snapshots legados recebem backfill automatico e
  `operational_schema_version=1` sem duplicacao.
- `schemaVersion` passou a 8.

**Por que**

Reescrever um documento grande para cada alteracao aumenta disputa, dificulta
consulta e impede integridade por entidade.

**Impacto e validacao**

- Consultas e concorrencia ficaram preparadas para crescimento.
- O smoke verifica importacao, backfill, indices e restauracao do contrato.

### 12. Comandos transacionais no Postgres - `2.0.19-lab`, PR #11

**O que mudou**

- Operacoes de comando passaram a bloquear linhas, conferir revisao e repetir
  ate tres vezes em deadlock ou falha de serializacao.
- Indices unicos impedem mais de um comando ativo por porta e duplicidade de
  `executionId`.
- Lease, ACK, conclusao e efeitos sobre entrega/porta ocorrem em transacao.
- Escritas genericas deixaram de sobrescrever comandos mais novos com snapshots
  antigos.
- `schemaVersion` passou a 9.

**Por que**

Duas replicas do Admin Online poderiam atender o mesmo locker ao mesmo tempo.
Sem bloqueio e unicidade, ambas poderiam entregar ou concluir o mesmo comando.

**Impacto e validacao**

- O protocolo remoto ficou seguro para execucao concorrente.
- Smoke com duas instancias verifica exclusao mutua, replay e efeito unico.

### 13. Logs operacionais estruturados - `2.0.20-lab`, PR #12

**O que mudou**

- Cada requisicao recebe ou propaga `x-request-id`.
- Logs incluem severidade, origem, rota, status, duracao, tenant, locker e ator.
- Corpo, query e cabecalhos de autenticacao nao sao registrados.
- Persistencia usa JSONL em laboratorio e tabela indexada no Postgres.
- Painel de suporte ganhou filtros, paginacao e CSV.
- Sanitizacao recursiva e retencao limitam segredos e dados pessoais.
- `schemaVersion` passou a 10.

**Por que**

Diagnosticar um locker remoto exige correlacionar navegador, API, dispositivo e
comando sem transformar logs em uma copia dos dados sensiveis.

**Impacto e validacao**

- Incidentes podem ser rastreados por `requestId` e contexto operacional.
- Testes validam redacao, armazenamento, consulta e expurgo.

### 14. Separacao Edge Agent / Kiosk UI - `2.0.21-lab`, PR #13

**O que mudou**

- `web/src/edgeAgent.js` tornou-se a unica fronteira web para RS-485,
  credencial nativa, armazenamento offline, heartbeat, eventos e comandos.
- `App.jsx`, comissionamento e diagnosticos deixaram de acessar transportes e
  diarios diretamente.
- O runtime serializa ciclos remotos, recuperacao e idempotencia.
- Hardware, rede, relogio, atualizador e storage passaram a ser injetaveis em
  testes.
- O agente permaneceu no mesmo APK para preservar o metodo de implantacao.

**Por que**

UI publica e controle de hardware mudam por motivos diferentes. O acoplamento
anterior tornava testes, manutencao e uma futura extracao para Android Service
mais arriscados.

**Impacto e validacao**

- O fluxo visual pode evoluir sem conhecer detalhes de serial ou HMAC.
- O contrato do Edge Agent e testado isoladamente e permite futura separacao de
  processo sem reescrever o kiosk.

### 15. Atualizacao remota segura do APK - `2.0.22-lab`, PR #14

**O que mudou**

- Admin Online ganhou politica por locker com canal, release, percentual de
  rollout, URL HTTPS e SHA-256.
- Rollout e deterministico e pode ser pausado imediatamente.
- Manifesto so e entregue ao Edge Agent quando o locker esta ocioso, sem
  operacao fisica nem comando em andamento.
- Android limita download a 250 MB, revalida HTTPS em redirecionamentos e
  confere hash, pacote, `versionCode` superior e certificado.
- Retorno do instalador dispara nova validacao; downgrade remoto e recusado.
- Heartbeat e painel mostram estado, tentativa, erro e versao do atualizador.
- `schemaVersion` passou a 11.

**Por que**

ADB manual nao escala e um APK remoto sem validacao poderia instalar software
corrompido, de outro pacote ou assinado por terceiro.

**Impacto e validacao**

- A frota pode receber atualizacao gradual e auditavel.
- O instalador Android continua sendo a autoridade final, inclusive para
  permissao de fonte desconhecida.
- Testes nativos cobrem manifesto, hash, assinatura, versao e estados de erro.

### 16. Wake-up MQTT com AWS IoT Core - `2.0.23-lab`, PR #15

**O que mudou**

- Mudanca de comando, morador ou politica e persistida primeiro e depois gera
  um wake-up MQTT QoS 1.
- Edge Agent conecta por WSS, antecipa o snapshot ao receber aviso e mantem
  polling HTTP de seis segundos como fallback; com MQTT saudavel, o ciclo de
  contingencia fica em 30 segundos.
- Tickets STS duram 15 minutos e recebem session policy exata para cliente e
  topico do locker, sem wildcard amplo.
- MQTT carrega apenas versao, `eventId`, `lockerId`, motivo e horario; nao leva
  comando, morador, PIN ou credencial.
- Reconexao e deduplicacao tratam a natureza "pelo menos uma vez" do QoS 1.

**Por que**

Polling curto aumenta trafego e ainda adiciona latencia. Substituir a API pelo
broker, por outro lado, criaria duas fontes de verdade.

**Impacto e validacao**

- Comandos chegam mais rapido quando AWS esta disponivel.
- Falha de IoT, STS ou WebSocket nao interrompe a operacao HTTP.
- Testes verificam publicacao posterior ao commit, privilegio minimo,
  deduplicacao e fallback.

### 17. Contratos de API e E2E do kiosk - `2.0.24-lab`, PR #16

**O que mudou**

- O teste consumidor-servidor passou a importar o `remoteBridge` real e a
  conversar com o `server.mjs` real usando a ponte HMAC nativa.
- O contrato cobre login, CSRF, morador, heartbeat, snapshot, eventos, MQTT,
  lease, ACK, conclusao e logout.
- Playwright passou a executar o bundle usado nos assets Android com ponte
  `window.Android` e respostas RS-485 deterministicas.
- A jornada cobre deposito, fechamento, PIN, retirada da mesma porta, novo
  fechamento e persistencia apos reload.
- CI instala Chromium e guarda screenshot, video, trace e arvore acessivel
  somente quando ha falha.

**Por que**

Testes unitarios isolados nao detectam divergencia entre payload da UI, API,
persistencia e bridge Android.

**Impacto e validacao**

- Mudanca incompatível de contrato quebra o CI antes de chegar ao equipamento.
- O E2E prova o caminho publico completo sem substituir o teste fisico de
  chicote, sensor e temporizacao.

### 18. Privacidade e ciclo de vida - `2.0.25-lab`, PR #17

**O que mudou**

- PIN, token, QR e codigo externo sao apagados assim que a entrega termina,
  tanto no kiosk quanto antes da persistencia no servidor.
- Evento offline antigo nao consegue restaurar credencial de uma entrega
  terminal; reenvio e tratado sem duplicar efeito.
- Fotos/OCR, dados pessoais, registro anonimizado, auditoria, comandos,
  notificacoes, IDs de evento, backups e logs receberam prazos configuraveis.
- Notificacoes pendentes de entrega terminal sao canceladas.
- Auditoria e exportacoes sao sanitizadas; CSV de entregas nao inclui PIN.
- Um worker aplica a politica no startup, antes de persistencias e em intervalo
  configuravel, nos modos JSON e Postgres.
- Sindico e Admin Geral ganharam resumo da politica, execucao manual, exportacao
  por titular e eliminacao de cadastro.
- Eliminacao e bloqueada com entrega ativa; historico terminal e anonimizado.
- Recuperacao valida pode ser sanitizada pela politica, mas o conteudo original
  permanece em backup conforme a retencao. JSON invalido continua sem ser
  sobrescrito.
- `schemaVersion` passou a 12.

**Por que**

Credenciais de retirada perdem a finalidade depois da coleta e dados pessoais
nao devem ser conservados indefinidamente. O produto tambem precisa apoiar o
processo de acesso e eliminacao do titular.

**Impacto e validacao**

- Menor exposicao em banco, logs, CSV e backups.
- Testes puros, workflow, smoke JSON/Postgres, contrato e E2E validam expurgo,
  anonimização, bloqueio por entrega ativa e ausencia de credenciais apos
  reload.
- Os prazos tecnicos nao substituem decisao juridica, base legal ou processo de
  verificacao de identidade do controlador.

## Arquitetura final por componente

### `web/` - kiosk e Edge Agent

- `App.jsx` apresenta os fluxos de entregador, morador e administracao local.
- `lockerWorkflow.js` concentra regras puras de entrega e retirada.
- `edgeAgent.js` coordena serial, rede, diarios, comandos, MQTT e atualizador.
- `doorSafety.js` valida prova fisica e polaridade.
- `remoteBridge.js` implementa o contrato HTTP autenticado.
- `commandWakeup.js` implementa MQTT WSS opcional e fallback.
- O estado local continua permitindo operacao sem internet; credenciais
  terminais sao removidas no momento da conclusao.

### `android/` - hardware, segredo e instalacao

- `MainActivity.java` hospeda a WebView restrita e seleciona a serial, priorizando
  `/dev/ttyS5` no hardware validado.
- `Rs485FrameParser.java` trata chunks, ruido, frames colados e BCC.
- `DeviceCredentialStore.java` protege a chave HMAC no Keystore.
- `AppUpdateManager.java` baixa e valida APK antes do instalador do sistema.
- Release usa `applicationId` `com.preddita.entregaslocker`, assinatura externa
  e `versionCode` monotonicamente crescente.

### `admin-online/` - API, painel e persistencia

- `server.mjs` aplica autenticacao, autorizacao, contratos, notificacoes,
  auditoria, privacidade e endpoints de dispositivo.
- `operationalStore.mjs` normaliza moradores, entregas e auditoria.
- `commandStore.mjs` controla comandos transacionais.
- `operationalLogStore.mjs` persiste logs estruturados.
- `privacyLifecycle.mjs` sanitiza e aplica retencao.
- `iotCommandBus.mjs` publica wake-ups e emite tickets temporarios.
- O painel oferece operacao, diagnostico, comandos, atualizacao, logs, usuarios,
  MFA e privacidade conforme o papel autenticado.

### `scripts/`, CI e documentacao

- Scripts exercitam workflow, seguranca de portas, diarios, serial,
  comissionamento, HMAC/Keystore, MFA, stores Postgres, logs, MQTT, privacidade,
  contrato de API e E2E.
- `scripts/v2-verify.ps1` agrega a matriz principal de verificacao.
- `.github/workflows/ci.yml` protege PRs e a branch principal.
- `.github/workflows/release-android.yml` gera o release Android assinado.
- `docs/` registra arquitetura, runbook, autenticacao, CI/release, contratos,
  privacidade e este historico.

### Consolidacao documental posterior a `2.0.25-lab`

- Este relatorio central foi criado para reunir a justificativa das etapas que
  antes estava distribuida entre commits e documentos especializados.
- `docs/README.md` passou a funcionar como portal da documentacao no GitHub e
  `docs/UPDATES.md` como registro cronologico obrigatorio de novas revisoes.
- Um template de pull request lembra autores de atualizar o registro quando a
  documentacao for alterada.
- O CI valida links locais e exige uma entrada em `docs/UPDATES.md` quando um PR
  altera Markdown ou exemplos de ambiente.
- O README foi atualizado para Node.js 20.19, JDK 17, pacote Android
  `com.preddita.entregaslocker`, versao `2.0.25-lab` e serial validada
  `/dev/ttyS5`.
- `scripts/deploy.sh test-serial` passou a usar `/dev/ttyS5` por padrao e aceita
  outra porta por `PREDDITA_SERIAL_PORT`, alinhando diagnostico e hardware.
- O runbook passou a distinguir JSON invalido, que nunca e sobrescrito, de
  estado valido que pode ser sanitizado pela politica com backup anterior.
- O contrato E2E passou a registrar explicitamente que credenciais terminais
  continuam apagadas depois do reload.
- Notas de hardware e comandos locais do Admin Online foram alinhados com a
  serial validada e com a estrutura atual do repositorio.
- O baseline V3 preservou nove estados, metricas e regressao Playwright nos
  viewports `1024x600`, `1280x800`, `800x480` e `390x844`.
- A Parte 2 do Kiosk V4 substituiu a home por uma composicao full-screen de
  alto contraste, adicionou fonte e icones offline e criou cinco prototipos
  sem side effects para aprovacao antes da integracao das jornadas reais.
- A Parte 3 integrou apartamento, confirmacao, portas, espera, sucesso, PIN,
  QR e excecoes ao fluxo real; removeu o JSX/CSS publico V3 e preservou o Admin.
- Fallback grande e cancelamento passaram a aguardar a leitura individual de
  fechamento da porta pequena; retirada por QR ganhou prova E2E pelo `jsQR`.
- Treze capturas reais documentam a jornada V4, com bundle de `953.710 bytes`
  (`319.470 bytes` gzip) e zero erro de console.
- A Parte 4 adicionou 12 prompts locais opcionais, iniciou em mudo, limitou o
  volume e persistiu somente preferencia sem identidade.
- A allowlist impede fala dinamica e os testes bloqueiam nome, apartamento,
  bloco, porta, PIN, QR ou numeros literais nas transcricoes.
- Duas capturas documentam o dialogo responsivo; os audios atuais sao assets de
  laboratorio e exigem confirmacao de direito de distribuicao antes de producao.
- A Parte 5 criou o console tecnico autenticado com allowlist nativa, seis abas,
  controles limitados, auditoria e teste de porta com prova fisica.
- A Parte 6 moveu a autoridade da UART para uma fila Java unica, correlacionou
  cada resposta por `executionId` e restringiu retry a leitura.
- Atuacao sem resposta nao e repetida: o canal fica bloqueado ate leitura de
  sensor, enquanto o diario persistente continua protegendo comandos remotos
  entre reinicios.
- Fila, espera, timeout, ruido, falha de I/O e reabertura passaram a ter
  metricas sanitizadas no Edge Agent e no console tecnico.
- Esta consolidacao nao altera contrato de API, schema ou versao do produto.

## Evolucao de dados e compatibilidade

| Marco | Versao de schema | Efeito |
| --- | ---: | --- |
| Recuperacao e contratos iniciais | 7 ou anterior | Leitura compatível dos snapshots recuperados |
| Tabelas operacionais | 8 | Moradores, entregas, comandos e auditoria normalizados |
| Comandos transacionais | 9 | Revisao, unicidade e efeitos atomicos |
| Logs estruturados | 10 | Store e API de logs operacionais |
| Politica de atualizacao | 11 | Estado de rollout e telemetria do APK |
| Ciclo de privacidade | 12 | Politica, resumo, expurgo e controles do titular |

Regras de compatibilidade importantes:

- `state.json` com BOM valido e aceito.
- JSON invalido nao e substituido automaticamente.
- Snapshot Postgres legado recebe backfill uma unica vez.
- Fila offline v1 migra para diario v2 antes de ser removida.
- Replays de evento, ACK e conclusao sao idempotentes.
- Recuperacao de APK nunca usa downgrade; uma correcao deve aumentar
  `versionCode` e manter o certificado.

## Configuracoes introduzidas ou endurecidas

As listas completas e defaults ficam em `admin-online/.env.example` e
`admin-online/.env.production.example`. Os grupos principais sao:

| Finalidade | Configuracoes principais |
| --- | --- |
| Identidade e URL | `PREDDITA_BASE_URL`, `PREDDITA_TENANT_ID`, `PREDDITA_LOCKER_ID`, `PREDDITA_ALLOWED_ORIGINS`, `PREDDITA_TRUST_PROXY` |
| Dispositivo HMAC | `PREDDITA_DEVICE_AUTH_MODE`, `PREDDITA_DEVICE_KEYS`, `PREDDITA_DEVICE_SIGNATURE_TTL_MS`, `PREDDITA_DEVICE_RATE_LIMIT_PER_MINUTE` |
| Admin e MFA | `PREDDITA_ADMIN_USERS`, `PREDDITA_ADMIN_SESSION_TTL_MS`, `PREDDITA_MFA_ENCRYPTION_KEY`, limites de login/admin/abertura |
| Persistencia | `PREDDITA_STORAGE`, `PREDDITA_DATABASE_URL`, `PREDDITA_DATA_DIR`, `PREDDITA_TEST_DATABASE_URL` |
| E-mail | `PREDDITA_SMTP_HOST`, porta, TLS, usuario, senha, remetente e politica de outbox |
| MQTT | `PREDDITA_IOT_MODE`, `PREDDITA_IOT_REGION`, `PREDDITA_IOT_ENDPOINT`, `PREDDITA_IOT_DEVICE_ROLE_ARN`, `PREDDITA_IOT_TOPIC_PREFIX`, TTL do ticket |
| Privacidade | controlador, contato, intervalo e prazos `PREDDITA_*_RETENTION_DAYS` |
| APK assinado | `PREDDITA_RELEASE_KEYSTORE`, alias e senhas, ou keystore Base64 no CI |

Valores legados como `PREDDITA_ADMIN_TOKEN`, `PREDDITA_SUPER_ADMIN_TOKEN` e
chave do dispositivo no bundle existem apenas para migracao/laboratorio e nao
devem ser usados como desenho de producao.

## Validacao acumulada

O projeto passou a verificar, em camadas:

1. Regras puras de workflow e privacidade.
2. Parser RS-485 e seguranca de portas.
3. Diarios offline e comandos idempotentes.
4. HMAC, Keystore, login, CSRF, papeis e MFA.
5. Stores JSON/Postgres, backfill, restart e concorrencia entre replicas.
6. Logs, MQTT, atualizador e ciclo de retencao.
7. Contrato real entre `remoteBridge` e Admin Online.
8. Jornada Playwright do bundle Android.
9. Regressao visual das jornadas V4 em quatro viewports e captura de 13 estados.
10. Politica e integridade do audio, com comportamento real em quatro viewports.
11. Build web, build Android, auditoria de dependencias e release assinado no CI.

O release `v2.0.25-lab` teve APK e checksum publicados, e o checksum baixado foi
comparado com o artefato da release.

## Alteracoes que exigem atencao na implantacao

- Node.js precisa ser `20.19` ou superior por causa do Vite 8.
- O pacote Android atual e `com.preddita.entregaslocker`; comandos ADB antigos
  com `com.preddita.locker` nao funcionam.
- A serial prioritaria no equipamento validado e `/dev/ttyS5`; variantes devem
  ser diagnosticadas antes do comissionamento.
- Produção exige HTTPS, credencial HMAC provisionada no Keystore, banco,
  assinatura Android propria e chave externa de MFA.
- Migracao para Postgres deve ser testada com backup e
  `PREDDITA_TEST_DATABASE_URL` antes de trocar a fonte de producao.
- Primeiro update remoto pode exigir autorizacao de instalacao pelo Android.
- MQTT e opcional; a instalacao precisa permanecer funcional somente por HTTP.
- Prazos de retencao precisam de aprovacao do controlador e avaliacao juridica.

## Decisoes conscientes e limites atuais

- **Edge Agent no mesmo APK:** a fronteira de codigo foi separada, mas ainda
  nao virou Android Service independente para evitar mudar o deploy antes do
  piloto.
- **MQTT nao e fonte de verdade:** ele reduz latencia, mas nao substitui API,
  HMAC ou Postgres.
- **Instalador Android permanece soberano:** o app prepara e valida a
  atualizacao, mas nao contorna as protecoes do sistema operacional.
- **E2E nao substitui hardware:** polaridade, chicote, energia, tempo de pulso e
  sensor precisam de comissionamento no equipamento.
- **Controles tecnicos nao substituem governanca LGPD:** base legal, avisos,
  contratos, excecoes de conservacao e verificacao do titular continuam sendo
  responsabilidades organizacionais.
- **Versao ainda marcada como `lab`:** a engenharia foi endurecida, mas a
  promocao para producao depende de piloto controlado e evidencias operacionais.

## Proximos passos recomendados

1. Executar piloto controlado em um locker com checklist de instalacao,
   comissionamento e rollback.
2. Medir estabilidade de serial, sensores, rede, SMTP, MQTT e atualizacao por
   um periodo definido.
3. Simular perda de energia, internet, restart durante comando e restauracao de
   backup.
4. Validar prazos de privacidade e processo do titular com controlador e
   assessoria juridica.
5. Registrar SLOs, alertas e procedimento de resposta a incidente com base nos
   logs estruturados.
6. Depois do piloto, decidir a promocao de `lab` para producao e se o Edge Agent
   deve virar um Android Service separado.

## Mapa de entregas no GitHub

| Etapa | Referencia |
| --- | --- |
| Diario offline e comandos duraveis | [PR #1](https://github.com/PredditaTi/Locker-Preddita/pull/1) |
| CI e release Android | [PR #2](https://github.com/PredditaTi/Locker-Preddita/pull/2) |
| HMAC do dispositivo | [PR #3](https://github.com/PredditaTi/Locker-Preddita/pull/3) |
| Android Keystore | [PR #4](https://github.com/PredditaTi/Locker-Preddita/pull/4) |
| Sessoes e papeis | [PR #5](https://github.com/PredditaTi/Locker-Preddita/pull/5) |
| Prova fisica das portas | [PR #6](https://github.com/PredditaTi/Locker-Preddita/pull/6) |
| Comissionamento | [PR #7](https://github.com/PredditaTi/Locker-Preddita/pull/7) |
| Sessoes Postgres | [PR #8](https://github.com/PredditaTi/Locker-Preddita/pull/8) |
| MFA | [PR #9](https://github.com/PredditaTi/Locker-Preddita/pull/9) |
| Dados normalizados | [PR #10](https://github.com/PredditaTi/Locker-Preddita/pull/10) |
| Comandos transacionais | [PR #11](https://github.com/PredditaTi/Locker-Preddita/pull/11) |
| Logs estruturados | [PR #12](https://github.com/PredditaTi/Locker-Preddita/pull/12) |
| Edge Agent | [PR #13](https://github.com/PredditaTi/Locker-Preddita/pull/13) |
| Atualizacao remota | [PR #14](https://github.com/PredditaTi/Locker-Preddita/pull/14) |
| Wake-up MQTT | [PR #15](https://github.com/PredditaTi/Locker-Preddita/pull/15) |
| Contratos e E2E | [PR #16](https://github.com/PredditaTi/Locker-Preddita/pull/16) |
| Privacidade e retencao | [PR #17](https://github.com/PredditaTi/Locker-Preddita/pull/17) |

### 2026-07-21 - Console tecnico autenticado e limitado

- O acesso tecnico deixou de aceitar parametro de URL, PIN em `localStorage` ou
  abertura permissiva sem credencial.
- O Android passou a derivar o PIN com PBKDF2 e salt aleatorio, aplicar lockout
  e manter uma sessao nativa curta.
- Uma bridge dedicada aceita somente leituras, ajustes numericos limitados,
  toggle de tela e retry serial sem argumentos.
- O console foi reorganizado em seis abas com status serial/rede/Edge,
  comissionamento, preview temporario da camera, tela e update.
- Todo teste de porta exige confirmacao e registra inicio, resultado e prova de
  fechamento; ajustes persistentes tambem entram no diario local.
- Testes de contrato e Playwright cobrem bloqueio, autenticacao, timeout,
  allowlist, quatro viewports e o ciclo fisico simulado.
- Tres referencias visuais e o procedimento completo foram registrados em
  [KIOSK-V4-CONSOLE-TECNICO.md](KIOSK-V4-CONSOLE-TECNICO.md).

## Documentos relacionados

- [Central de documentacao](README.md)
- [Atualizacoes da documentacao](UPDATES.md)
- [Arquitetura tecnica](ARCHITECTURE.md)
- [Runbook de desenvolvimento](DEVELOPER-RUNBOOK.md)
- [CI e releases](CI-RELEASE.md)
- [Autenticacao do dispositivo](DEVICE-AUTH.md)
- [Contratos de API e E2E](API-CONTRACTS-E2E.md)
- [Baseline visual do Kiosk V3](KIOSK-V3-BASELINE.md)
- [Fundacao visual do Kiosk V4](KIOSK-V4-FUNDACAO-VISUAL.md)
- [Jornadas publicas do Kiosk V4](KIOSK-V4-JORNADAS-PUBLICAS.md)
- [Audio acessivel do Kiosk V4](KIOSK-V4-AUDIO-ACESSIVEL.md)
- [Console tecnico do Kiosk V4](KIOSK-V4-CONSOLE-TECNICO.md)
- [Resiliencia serial do Kiosk V4](KIOSK-V4-RESILIENCIA-SERIAL.md)
- [Privacidade e ciclo de vida](PRIVACY-DATA-LIFECYCLE.md)
- [Revisao e plano executado](REVISAO-PLANO-MELHORIA-2026-07-08.md)
- [Direcao tecnica v2](V2-ROADMAP.md)
