# Privacidade e ciclo de vida dos dados

Este documento descreve os controles tecnicos da PREDDITA Locker. Ele nao
substitui a definicao de base legal, avisos de privacidade, contratos ou a
avaliacao juridica do controlador.

## Principios aplicados

- O cadastro usa apartamento, predio, andar, telefone e e-mail; CPF e nome do
  morador nao sao necessarios para o fluxo e permanecem vazios.
- PIN, token, QR e codigo externo existem somente enquanto a entrega esta
  ativa. Coleta, cancelamento ou expiracao apagam essas credenciais
  imediatamente no kiosk e no servidor.
- Fotos e resultados de OCR sao evidencias temporarias e possuem prazo proprio.
- Dados pessoais do historico terminal sao anonimizados antes da remocao final
  do registro operacional.
- Auditoria e logs recebem sanitizacao recursiva antes da persistencia.
- O CSV de entregas nao exporta credenciais de retirada.
- Metricas do piloto nao possuem unidade, pessoa, porta, credencial, imagem,
  audio ou texto livre e sao limitadas a 500 amostras por locker.

## Politica padrao

| Categoria | Acao | Padrao |
| --- | --- | ---: |
| Credenciais de entrega terminal | Apagar | Imediato |
| Foto e OCR da etiqueta | Apagar | 30 dias |
| Dados pessoais da entrega terminal | Anonimizar | 90 dias |
| Registro de entrega anonimizado | Apagar | 730 dias |
| Auditoria de negocio | Apagar | 365 dias |
| Comandos encerrados | Apagar | 365 dias |
| Notificacoes encerradas | Apagar | 30 dias |
| IDs de eventos processados | Apagar | 365 dias |
| Backup JSON local | Apagar | 7 dias |
| Logs tecnicos | Apagar | 30 dias |
| Metricas sanitizadas do piloto | Substituir pelas mais recentes | 500 amostras |

Os prazos sao defaults tecnicos conservadores, nao prazos impostos pela LGPD.
Antes da producao, o controlador deve confirmar finalidade, base legal,
obrigacoes legais ou regulatorias e os prazos aplicaveis ao seu contexto.

## Direitos do titular

Sindico e Admin Geral possuem a tela `Privacidade` no painel:

- `Exportar dados` gera JSON com o cadastro, entregas relacionadas e auditoria
  pertinente, sem valores de PIN, token ou QR.
- `Eliminar cadastro` remove o apartamento e anonimiza entregas encerradas.
- A eliminacao e bloqueada enquanto houver entrega ativa, para nao impedir a
  retirada de um volume ainda armazenado.
- `Executar agora` aplica a politica e devolve contadores auditaveis.

Uma solicitacao deve continuar passando pela verificacao de identidade e pelo
processo organizacional do controlador. Excecoes de conservacao previstas em
lei devem ser avaliadas antes de acionar a eliminacao.

## Configuracao

```text
PREDDITA_PRIVACY_CONTROLLER_NAME
PREDDITA_PRIVACY_CONTACT_EMAIL
PREDDITA_PRIVACY_SWEEP_INTERVAL_MS=21600000
PREDDITA_DELIVERY_EVIDENCE_RETENTION_DAYS=30
PREDDITA_DELIVERY_PERSONAL_DATA_RETENTION_DAYS=90
PREDDITA_DELIVERY_RECORD_RETENTION_DAYS=730
PREDDITA_AUDIT_RETENTION_DAYS=365
PREDDITA_COMMAND_RETENTION_DAYS=365
PREDDITA_NOTIFICATION_RETENTION_DAYS=30
PREDDITA_PROCESSED_EVENT_RETENTION_DAYS=365
PREDDITA_BACKUP_RETENTION_DAYS=7
PREDDITA_OPERATIONAL_LOG_RETENTION_DAYS=30
```

O servidor alerta quando controlador ou contato nao foram definidos. O ciclo
roda no startup, antes de cada persistencia e periodicamente; a tela permite uma
execucao manual adicional. As mesmas regras sao aplicadas aos modos JSON e
Postgres.

O limite de amostras do piloto e um controle de minimizacao, nao uma definicao
juridica de prazo. Antes de observar usuarios reais, o controlador deve aprovar
finalidade, aviso e periodo do piloto. Filmagem e gravacao de audio ficam
desativadas por padrao e exigem avaliacao separada.

## Referencias oficiais

- [LGPD compilada, arts. 15 e 16](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm)
- [ANPD: direitos dos titulares](https://www.gov.br/anpd/pt-br/assuntos/titular-de-dados-1/direito-dos-titulares)
- [ANPD: glossario e principio da necessidade](https://www.gov.br/anpd/pt-br/documentos-e-publicacoes/glossario-anpd)
