# Piloto controlado do Kiosk V4

Este documento encerra a preparacao de laboratorio da Parte 8 e define como a
equipe deve validar a release candidata `2.0.31-lab` em um KS1062 real. Ele nao
substitui comissionamento, instalacao controlada nem consentimento do local.

## Estado em 21 de julho de 2026

### Preparacao de software concluida

- [x] Jornada local persistida sem apartamento, morador, PIN, QR ou porta.
- [x] Tempo, resultado, modo PIN/QR, fallback, ajuda e erros agregados.
- [x] Admin Online com resumo do piloto, amostras sanitizadas e preflight.
- [x] Preflight bloqueante para sinal, serial, comissionamento, HMAC, versao,
  update, rollout e mapa de portas.
- [x] Verificacao ADB somente leitura, sem acionar portas.
- [x] Release candidata `2.0.31-lab`, `versionCode 31`, schema `13` preparada.

### Evidencia de release concluida

- [x] APK assinado gerado, publicado e checksum conferido.

A prerelease imutavel
[`v2.0.31-lab`](https://github.com/PredditaTi/Locker-Preddita/releases/tag/v2.0.31-lab)
foi gerada pelo
[`Release APK` #29860294336](https://github.com/PredditaTi/Locker-Preddita/actions/runs/29860294336)
em 21 de julho de 2026, a partir do commit
`cb2fc2b16ced77f3f63136e3686ce8e050f48926`.

- APK: `PREDDITA-Locker-2.0.31-lab-release.apk`, 3.389.495 bytes.
- SHA-256: `fd79beaa803d5d031c72e5c576b2a1c52cad7f6df35e761793931aae1576b25c`.
- Assinatura: APK Signature Scheme v2, um signatario, validada por `apksigner`.
- Certificado SHA-256:
  `5E:D9:93:C1:04:91:D5:FF:58:0D:85:D3:BC:C4:5F:53:CE:21:3F:19:9A:F3:44:D3:79:56:A7:AA:F1:9D:59:2D`.
- Conferencia independente: APK e arquivo `.sha256` baixados da release; o
  comando `shasum -a 256 -c` retornou `OK`.

### Evidencia em equipamento ainda obrigatoria

- [ ] Locker comissionado e autorizado para o piloto.
- [ ] Matriz de jornadas executada no KS1062.
- [ ] Falhas de rede, energia, UART e porta reproduzidas com seguranca.
- [ ] Health check e pausa de rollout observados no equipamento.
- [ ] Usuarios reais observados com consentimento e sem gravacao por padrao.

Enquanto algum item em equipamento estiver pendente, a release continua sendo de
laboratorio e nao deve ser distribuida amplamente.

## Dados coletados

Cada jornada envia somente:

| Campo | Uso |
| --- | --- |
| Tipo | Entrega ou retirada |
| Resultado | Concluida, cancelada, falhou ou foi interrompida |
| Duracao | Tempo total, limitado a 30 minutos |
| Modo | PIN, QR ou nao aplicavel |
| Fallback | Se a entrega precisou de porta maior |
| Ajuda | Se o botao de ajuda foi usado |
| Erros | Contagem limitada, sem mensagem livre |
| Motivo | Codigo fechado e nao identificavel |

O servidor aceita apenas a allowlist acima e limita o conjunto a 500 amostras
por locker. Campos extras sao descartados. Nao registrar nomes, unidade,
imagem, audio, PIN, QR, etiqueta, porta ou observacao livre na planilha do
piloto.

## Preflight

No servidor que possui o estado do locker:

```bash
export PREDDITA_DEVICE_AUTH_MODE=hmac
node scripts/pilot-preflight.mjs \
  --state admin-online/data/state.json \
  --expected-version 2.0.31-lab
```

O comando termina com codigo `2` quando existe bloqueio. No computador ligado
ao KS1062, a verificacao ADB somente leitura e:

```bash
./scripts/deploy.sh pilot-check
```

No Windows:

```powershell
.\scripts\deploy.ps1 pilot-check
.\scripts\deploy.ps1 pilot-preflight -PilotStateFile .\admin-online\data\state.json
```

O painel **Piloto** mostra os mesmos gates operacionais. A aprovacao humana da
instalacao e da janela de teste continua obrigatoria.

## Sequencia do piloto

1. Publicar o APK pelo workflow `Release APK`, canal `lab`, e conferir
   certificado e SHA-256 do artefato. Concluido na release `v2.0.31-lab`.
2. Instalar em um unico locker comissionado. Nao habilitar rollout superior a
   10% nem canal `production`.
3. Confirmar HMAC, sinal recente, serial aberta, mapa de portas e health check.
4. Executar a matriz abaixo sem encomendas reais na primeira rodada.
5. Repetir a matriz com usuarios autorizados, consentimento registrado e um
   operador ao lado do equipamento.
6. Exportar apenas totais e taxas do painel. Registrar defeitos tecnicos em
   issue separada, sem dados pessoais.
7. Decidir avancar, corrigir e repetir, ou encerrar o piloto.

## Matriz obrigatoria

| Cenario | Evidencia esperada | Status |
| --- | --- | --- |
| Entrega em porta pequena | Ciclo fechada-aberta-fechada e metrica concluida | Pendente |
| Fallback para porta grande | Porta pequena fechada antes da grande e fallback contado | Pendente |
| Retirada por PIN | Credencial apagada depois da coleta e modo PIN contado | Pendente |
| Retirada por QR | Camera, abertura e limpeza concluidas; modo QR contado | Pendente |
| Audio ligado e mudo | Jornada nao muda e preferencia persiste | Pendente |
| Reinicio durante jornada | Jornada anterior aparece como interrompida, sem PII | Pendente |
| Internet ausente e reconexao | Operacao local continua e diario sincroniza uma vez | Pendente |
| Queda de energia | Estado retorna sem reabrir porta nem repetir comando | Pendente |
| Ruido serial | Leitura pode repetir; atuacao incerta nao repete | Pendente |
| Porta travada | Falha e orientacao aparecem sem liberar ocupacao indevida | Pendente |
| UART indisponivel | Preflight bloqueia e recuperacao restaura a serial | Pendente |
| Update saudavel | Estado `healthy` e amostra unica no rollout | Pendente |
| Update defeituoso | Nova oferta pausa no limite; locker saudavel permanece ativo | Pendente |

## Criterios de parada

Interromper imediatamente o piloto se houver abertura dupla, abertura da porta
errada, perda de ocupacao, credencial reaparecendo apos coleta, comando remoto
sem prova fisica, falha de assinatura, serial em estado desconhecido ou
exposicao de dado pessoal. Pausar o rollout no Admin antes de investigar.

Falha visual, audio ausente ou camera indisponivel tambem bloqueiam o cenario
afetado, mas nao autorizam bypass das regras fisicas.

## Recuperacao

1. Pausar a distribuicao no Admin e preservar logs sanitizados.
2. Nao forcar nova abertura para descobrir o estado da porta.
3. Confirmar sensor e ocupacao fisicamente com duas pessoas quando houver
   atuacao de resultado desconhecido.
4. Reiniciar o app apenas depois de registrar o estado observado.
5. Recuperar por APK assinado com `versionCode` superior via ADB ou MDM. O
   projeto nao promete downgrade automatico.
6. Executar novamente `pilot-check` e `pilot-preflight` antes de retomar.

O rollback funcional preservado e a release `v2.0.25-lab`. Como o Android
normalmente bloqueia downgrade, a recuperacao deve republicar esse codigo com
um `versionCode` superior e a mesma chave de assinatura.

## Observacao de usuarios

- Informar objetivo, duracao e dados coletados antes da participacao.
- Permitir recusa sem impacto no acesso do morador ou entregador.
- Nao filmar nem gravar audio por padrao.
- Usar identificadores de sessao nao vinculados a apartamento ou pessoa.
- Registrar somente dificuldade observada, etapa e resultado.
- Acionar o processo de privacidade se surgir necessidade de nova coleta.

## Recursos condicionais

Blocos/torres, tamanho `GG`, login de transportadora, API de pre-entrega,
hotspot, video e WhatsApp permanecem fora desta release. Cada item so pode
entrar depois de evidencia do piloto, decisao de produto e plano proprio de
seguranca, privacidade, operacao e testes.

## Criterio de encerramento

A Parte 8 somente pode ser marcada como concluida quando a matriz fisica tiver
responsavel, data, evidencia sanitizada e resultado; as taxas de conclusao,
ajuda, fallback e erro forem conhecidas; o procedimento de suporte tiver sido
executado; e cada recurso condicional possuir decisao explicita.
