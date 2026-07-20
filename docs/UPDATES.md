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
