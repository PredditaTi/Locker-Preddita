# Relatorio consolidado de implementacao e deploy

Este documento consolida a recuperacao do PREDDITA Locker, as melhorias feitas
no codigo, os motivos das decisoes e a implantacao controlada iniciada em 21 de
julho de 2026. Ele complementa o historico detalhado e os runbooks tecnicos sem
duplicar segredos, dados pessoais ou identificadores fisicos do equipamento.

## Escopo e fontes

O trabalho partiu dos arquivos recuperados em `Documents.rar`, das copias do
aplicativo anterior e do repositorio `PredditaTi/Locker-Preddita`. A analise
considerou o kiosk React, a bridge Android, o barramento RS-485, o Admin Online,
o estado local, o servidor legado e o aplicativo de referencia recuperado do
pendrive.

Fontes de detalhe:

- [Historico completo](HISTORICO-COMPLETO-DE-MELHORIAS.md).
- [Arquitetura atual](ARCHITECTURE.md).
- [Contratos e E2E](API-CONTRACTS-E2E.md).
- [Privacidade e ciclo de dados](PRIVACY-DATA-LIFECYCLE.md).
- [Plano do Kiosk V4](PLANO-IMPLEMENTACAO-MELHORIAS-REDESIGN-2026-07-20.md).
- [Piloto controlado](KIOSK-V4-PILOTO-CONTROLADO.md).

## Estado recuperado

A base original funcionava, mas misturava codigo, artefatos, configuracoes e
dados de maquina. Os riscos principais eram credenciais no frontend, estado
critico concentrado em `localStorage`, comandos remotos com confirmacao fraca,
administracao por token fixo, release com chave debug e falta de CI completo.

O material de referencia do pendrive foi analisado de forma estatica. O visual,
a hierarquia de jornadas e a densidade operacional serviram como inspiracao,
mas nenhum binario, segredo, marca ou codigo proprietario foi incorporado ao
PREDDITA Locker.

## Melhorias implementadas

### Recuperacao, repositorio e qualidade

- O codigo-fonte foi consolidado em um repositorio Git limpo e reproduzivel.
- Artefatos, backups, credenciais, keystores e dados operacionais foram
  separados do versionamento.
- O CI passou a testar JavaScript, contratos Android, parser RS-485, Postgres,
  E2E Playwright, auditoria de dependencias, build Vite e APK debug.
- O workflow de release passou a exigir keystore externa, validar a assinatura,
  gerar SHA-256 e publicar releases imutaveis.

### Seguranca do armario e da API

- A chave do dispositivo saiu do bundle web e passou para o Android Keystore.
- Chamadas do locker usam HMAC com timestamp, nonce, hash de conteudo e limite
  de repeticao.
- O Admin passou de token no navegador para sessao `HttpOnly`, CSRF, papeis,
  escopo por locker, rate limit e MFA para contas privilegiadas.
- A bridge WebView foi limitada ao conteudo empacotado, sem navegacao externa,
  acesso universal a arquivos ou debug em release.
- O console tecnico usa PIN local protegido, sessao curta, lockout e allowlist
  de diagnosticos, sem shell arbitrario ou abertura remota de porta.

### Estado, comandos e operacao offline

- A fila offline monolitica virou diario duravel por evento, com migracao da
  estrutura antiga e reenvio idempotente.
- Comandos remotos ganharam `executionId`, lease, ACK, expiracao, conclusao
  transacional e protecao contra duas atuacoes concorrentes.
- A interface nao conclui entrega ou retirada sem a prova fisica
  fechada-aberta-fechada do canal correto.
- O comissionamento registra o mapa real das portas em vez de presumir a
  disposicao do hardware.

### Servidor, dados e observabilidade

- O armazenamento recomendado passou a Postgres 16, com tabelas por tenant e
  locker, migracao automatica e transacoes nas operacoes criticas.
- Sessoes administrativas, revogacoes e MFA persistem no banco.
- Logs operacionais estruturados possuem correlacao, filtros, exportacao e
  retencao, sem corpo de requisicao, PIN, QR ou texto pessoal livre.
- O ciclo LGPD ganhou expurgo, anonimizacao, exportacao e eliminacao controlada.
- MQTT AWS IoT funciona apenas como wake-up QoS 1; a API HTTP autenticada
  continua sendo a fonte de verdade.

### Kiosk V4 e experiencia publica

- Foi criada uma baseline visual antes do redesign e uma fundacao responsiva
  voltada ao painel fisico `1024x600`.
- Home, entrega, fallback de tamanho, retirada por PIN e retirada por QR foram
  convertidos em jornadas de tela cheia com regras fisicas preservadas.
- Audio acessivel e opcional foi adicionado sem pronunciar apartamento, nome,
  PIN, QR ou outra informacao pessoal.
- O frontend usa controles consistentes, tipografia legivel, alvos de toque
  estaveis, feedback de estado e adaptacao para desktop e viewport movel.

### Serial, update e piloto

- O acesso RS-485 ganhou fila nativa exclusiva, correlacao de resposta, timeout,
  metricas e recuperacao limitada.
- Leitura pode receber uma tentativa adicional; atuacao com resultado incerto
  nunca e repetida automaticamente.
- O atualizador separa APK instalado de versao saudavel e observa startup,
  WebView, estado, credencial e serial antes de concluir o update.
- Uma release ruim pausa novas ofertas no limite configurado, preservando os
  lockers que ja estavam saudaveis.
- O piloto coleta somente tipo, resultado, duracao, PIN/QR, fallback, ajuda e
  contagens fechadas de erro. Campos extras e texto livre sao descartados.
- Preflight do servidor e verificacao ADB somente leitura bloqueiam o piloto
  quando versao, HMAC, serial, mapa, update ou rollout estiverem inadequados.

## Versao candidata

| Item | Valor |
| --- | --- |
| Produto | `2.0.31-lab` |
| Android `versionCode` | `31` |
| API `schemaVersion` | `13` |
| Contrato do Edge Agent | `4` |
| Release | `v2.0.31-lab` |
| APK | `PREDDITA-Locker-2.0.31-lab-release.apk` |
| SHA-256 | `fd79beaa803d5d031c72e5c576b2a1c52cad7f6df35e761793931aae1576b25c` |
| Canal | Laboratorio; nao promovido para producao |

A assinatura APK v2 e o certificado lab foram validados pelo workflow e por
download independente do artefato.

## Diagnostico de implantacao

### Servidor legado

- O backend operacional foi localizado e responde ao health check.
- A versao encontrada e `2.0.8-lab`, schema `6`, servida apenas por HTTP.
- O dominio HTTPS conhecido aponta para outro servico e nao pode ser tratado
  como Admin Online sem verificar conta, projeto e DNS.
- A porta SSH esta acessivel, mas a chave privada da instancia nao foi
  recuperada nos arquivos locais nem nos dois RAR.
- A credencial administrativa da copia recuperada nao corresponde a instancia
  atual. O snapshot de dispositivo autenticado foi preservado.

### Armario piloto

- KS1062-N-ZY com Android 13, Wi-Fi validado e serial `/dev/ttyS5` presente.
- O pacote PREDDITA estava em execucao como launcher na versao `2.0.8-lab`.
- A instalacao antiga usa chave debug; a candidata usa a chave lab dedicada.
  O Android nao permite atualizar diretamente entre essas assinaturas.
- O estado local possui 52.555 bytes e foi copiado com o app parado para manter
  consistencia do LevelDB.
- APK antigo, dados do pacote, armazenamento de dispositivo e snapshot remoto
  foram preservados fora do repositorio, com acesso restrito e checksums.
- O snapshot remoto contem tres moradores e nenhum comando pendente. Nomes,
  unidades, credenciais e demais dados pessoais nao foram registrados aqui.

Nenhuma porta foi acionada durante o diagnostico ou o backup.

## Ordem segura do deploy

### 1. Servidor

1. Recuperar acesso da instancia existente ou validar o projeto de hospedagem
   que recebera o Admin Online.
2. Preservar o estado completo antes de substituir containers ou volumes.
3. Publicar o commit aprovado com Node.js 20.19+, Postgres 16 e HTTPS valido.
4. Configurar usuarios, MFA, tenant, locker, HMAC, retencao, SMTP e origens sem
   colocar valores no Git ou no historico do shell.
5. Validar `/api/healthz`, schema `13`, login, Postgres, logs e snapshot HMAC.
6. Manter MQTT desabilitado ate a role AWS e o endpoint serem validados.

### 2. Armario

1. Confirmar novamente backup, checksum e ausencia de comando remoto pendente.
2. Parar o app antigo e preservar o LevelDB antes da troca de assinatura.
3. Desinstalar somente depois que o servidor HTTPS estiver saudavel.
4. Instalar o APK imutavel `v2.0.31-lab` e restaurar apenas o estado local
   necessario, com proprietario e contexto corretos do novo UID.
5. Provisionar URL HTTPS, `lockerId`, chave HMAC e PIN tecnico diretamente no
   Android; a chave deve ficar nao exportavel no Keystore.
6. Iniciar o app, validar pacote, processo, serial, estado e health check sem
   acionar portas.
7. Executar a matriz fisica somente com responsavel presente e criterios de
   parada do runbook.

## Rollback

Se o servidor falhar, o backend legado deve permanecer intacto ate a nova
instancia provar health check, autenticacao e persistencia. Se a instalacao do
APK falhar, reinstale o APK antigo preservado e restaure o backup integral do
pacote com o UID correto. Nao use downgrade sobre a assinatura lab e nao apague
o backup antes do encerramento do piloto.

Se houver resultado serial incerto, perda de ocupacao, abertura dupla, porta
errada ou exposicao de dado pessoal, interrompa o piloto e nao envie nova
atuacao para descobrir o estado.

## Gates da implantacao

| Gate | Estado em 21/07/2026 |
| --- | --- |
| CI completo da candidata | Concluido |
| APK assinado e checksum | Concluido |
| Descoberta e diagnostico ADB | Concluido |
| Backup consistente do app antigo | Concluido |
| Snapshot remoto sanitizado | Concluido |
| Acesso administrativo ao host HTTPS | Bloqueado por autenticacao externa |
| Backend `2.0.31-lab`, schema `13` | Pendente |
| Instalacao do APK no KS1062 | Pendente do backend HTTPS |
| Provisionamento HMAC no Keystore | Pendente do backend HTTPS |
| Preflight e matriz fisica | Pendente |

Este quadro deve ser atualizado apos cada acao. Um gate pendente nao pode ser
marcado como concluido apenas porque o codigo ou o build passou em laboratorio.

