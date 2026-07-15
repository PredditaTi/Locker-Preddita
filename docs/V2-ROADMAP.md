# PREDDITA Locker 2.0 - estudo e direcao tecnica

Este documento descreve a direcao da versao 2.0 experimental. A pasta v2 foi criada para evoluir o software sem alterar a versao que esta rodando no armario.

## O que foi observado no mercado

Solucoes maduras de smart lockers se posicionam como plataformas completas, nao apenas como apps de abertura de portas.

- Portais cloud para administradores acompanharem portas, entregas, notificacoes, falhas, historico e dispositivos.
- App ou fluxo simples para morador com PIN, QR, notificacao e instrucoes claras de retirada.
- Suporte remoto com saude do locker, ultima comunicacao, status de sensores, fila de comandos e auditoria.
- Integracoes com APIs, webhooks, sistemas de condominio, transportadoras e ERPs.
- Controle de acesso com usuarios, papeis, logs, MFA e separacao entre operador, sindico, suporte e tecnico.
- Operacao offline/edge: o armario continua abrindo por PIN/QR mesmo se a internet cair.

## Comparativo com a v1 atual

| Area | V1 atual | Direcao v2 |
| --- | --- | --- |
| Persistencia | JSON local no servidor | Banco transacional com backups, migracoes e auditoria |
| Comandos remotos | Polling HTTP simples | Fila rastreavel, status detalhado e depois MQTT/IoT Core |
| Saude do dispositivo | Ultimo status bruto | Sinal fresco, stale detection, serial, bridge, SMTP e fila |
| Autenticacao | Token fixo no browser | Login real, perfis, MFA e rotacao de chaves |
| Admin | Abre portas e lista moradores | Centro operacional com diagnostico, comandos e auditoria |
| App do armario | Estado local + sync | Edge agent separado da UI publica |
| Atualizacao | ADB/manual | Canal de atualizacao com versao, rollout e rollback |
| Observabilidade | Logs manuais | Eventos estruturados, metricas e alertas |

## Arquitetura recomendada

1. **Edge Agent Android**
   - Responsavel por RS-485, sensores, fila local, operacao offline e heartbeat.
   - Deve ser separado da interface de entregador/morador.

2. **Kiosk UI**
   - Home com dois fluxos publicos: entregador e buscar entrega.
   - Sem funcoes administrativas sensiveis no kiosk publico.

3. **Cloud API**
   - Responsavel por moradores, entregas, comandos, auditoria e notificacoes.
   - Banco real e API versionada.

4. **Admin Web**
   - Painel do sindico e suporte.
   - Abertura remota com rastreamento do comando ate a confirmacao do armario.

5. **IoT/Command Bus**
   - Curto prazo: polling HTTP endurecido.
   - Medio prazo: AWS IoT Core com shadow/reportado/desejado, jobs de atualizacao e secure tunneling.

## Melhorias implementadas nesta v2 local

- Versao marcada como `2.0.0-lab`.
- Servidor admin com escrita atomica de estado e backups locais.
- Runtime summary no `/api/admin/state`, incluindo versao, freshness do armario, fila, SMTP e contadores.
- Token comparado com `timingSafeEqual`.
- Rate limit basico para APIs administrativas e abertura remota.
- Endpoint `GET /api/admin/commands/:id` para acompanhar comando remoto.
- Timeline de comandos: criado, entregue ao armario, concluido/falhou.
- Admin UI exibe saude operacional e rastreador de comando remoto.
- Botoes de abertura remota ficam bloqueados quando o armario nao esta pronto.
- Smoke test local sem AWS e sem armario fisico.
- Teste de workflow do kiosk cobrindo volume obrigatorio, portas grandes/pequenas, PIN, QR PREDDITA e liberacao de porta ocupada.
- Painel administrativo com login, sessoes HttpOnly, CSRF, papeis e escopo por locker.
- API de abertura remota recusa comandos quando o armario esta offline, com serial fechada ou ja tem comando pendente para a mesma porta.
- Healthcheck e painel mostram versao v2 e alertas de configuracao insegura antes de levar o servidor para producao.
- Script `scripts/v2-verify.ps1` roda workflow, smoke, sintaxe, auditoria e build local da v2.
- Deposito, retirada e abertura remota exigem prova persistida do ciclo fisico
  fechada-aberta-fechada; leituras em bloco nao liberam ocupacao.
- Perfil de polaridade individual (`zeroOpen`/`zeroClosed`) configuravel por
  armario, com regressao automatizada para os dois formatos.
- Assistente de comissionamento protegido para identificar cada canal, inferir
  a polaridade, aplicar o tempo de acionamento, registrar o ciclo
  fechada-aberta-fechada e mapear portas `P`, `M` e `G`.
- Configuracao comissionada persistida no locker e enviada ao Admin Online;
  qualquer mudanca de board, quantidade, tempo, polaridade ou mapa invalida as
  provas anteriores.
- Persistencia Postgres por `tenant_id` e `locker_id`, com importacao inicial do
  `state.json` e smoke executado no CI.
- Usuarios e sessoes administrativas em tabelas Postgres proprias. O banco
  guarda somente o SHA-256 do token de sessao; restart e logout preservam a
  validade ou revogacao do cookie.

## Proximas melhorias recomendadas

1. Adicionar MFA para contas `super_admin` e `suporte`.
2. Normalizar entregas, comandos, moradores e auditoria que ainda ficam no
   snapshot JSONB por locker.
3. Criar tabela/colecao de comandos com idempotencia e retry.
4. Implementar logs estruturados e exportaveis.
5. Separar `Edge Agent` e `Kiosk UI`.
6. Criar fluxo de atualizacao remota do APK.
7. Trocar polling por AWS IoT Core/MQTT.
8. Adicionar testes de contrato da API e testes de fluxo do kiosk.
9. Criar LGPD/data-retention: CPF, telefone, e-mail, auditoria e expiracao de entregas.

## Criterio de produto para ficar competitivo

A meta da v2 nao e apenas abrir portas. A meta e o sindico confiar que consegue operar o locker sozinho, o morador conseguir retirar sem ajuda, o entregador depositar em poucos toques e o suporte PREDDITA diagnosticar remotamente antes de mandar alguem ao local.
