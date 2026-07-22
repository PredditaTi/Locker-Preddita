# Dataset e calibracao da Entrega Inteligente

## Objetivo

Definir como uma versao candidata do classificador local `P/G/incerto` pode
ser produzida e aprovada sem misturar dados, expor etiquetas ou reduzir a
seguranca fisica. Este documento cobre a infraestrutura da Parte 5; ainda nao
existe dataset real nem modelo aprovado.

## Premissa fisica

Uma foto monocular sem referencia geometrica nao determina escala e
profundidade com confiabilidade. A coleta precisa reproduzir a camera, a
distancia e o enquadramento do armario. Se isso nao for suficientemente
estavel, o piloto deve adicionar uma referencia fisica de escala ou uma
segunda vista antes de treinar outra versao.

As dimensoes devem ser medidas em milimetros:

| Porta | Abertura util | Compartimento interno |
| --- | --- | --- |
| `P` | largura e altura | largura, altura e profundidade |
| `G` | largura e altura | largura, altura e profundidade |

Use a menor medida entre abertura e compartimento em cada eixo frontal. A
folga minima configurada e aplicada ao pacote, e nao adicionada artificialmente
ao espaco da porta.

## Rotulagem

O script testa as seis orientacoes de um pacote retangular:

- `P`: cabe em `P` com a folga minima;
- `G`: nao cabe em `P`, mas cabe em `G` com a folga minima;
- `uncertain`: cabe apenas sem a folga ou nao cabe em `G`.

O rotulo registrado precisa coincidir com o rotulo derivado das medidas. Um
erro de anotacao interrompe a validacao do manifesto.

## Coleta minima

Cada `packageId` representa um volume fisico, com medidas constantes. Colete
mais de uma vista quando a jornada permitir, cobrindo:

- caixas, envelopes plasticos, papel e formatos irregulares;
- iluminacao uniforme, baixa, contraluz e mista;
- vistas frontal, lateral, superior e obliqua;
- pacotes claramente `P`, claramente `G` e casos na fronteira;
- o mesmo modelo de camera e guia visual usados no locker.

O gate inicial exige pelo menos 50 pacotes fisicos de cada classe `P` e `G`, e
20 pacotes de fronteira, tanto na validacao quanto no teste. Esses minimos nao
garantem qualidade estatistica; devem aumentar quando a variabilidade real for
conhecida.

## Privacidade

Imagens brutas devem permanecer em armazenamento local controlado. Antes de
entrarem no manifesto:

1. confirmar autorizacao para a coleta;
2. remover ou tornar ilegivel nome, endereco, telefone, rastreio, QR e codigo
   de barras;
3. registrar `privacy.reviewed: true` e
   `privacy.personalDataVisible: false`;
4. calcular o SHA-256 depois da redacao;
5. eliminar capturas recusadas ou que nao possam ser anonimizadas.

Fotos reais, dados brutos e modelos candidatos sao ignorados pelo Git. Somente
um modelo aprovado e seu relatorio sanitizado podem entrar em uma release.

## Separacao dos dados

O comando `split` agrupa por `packageId`, estratifica por rotulo e usa uma seed
estavel. Assim, duas fotos do mesmo pacote nao aparecem em treino e teste. O
arquivo de scores tambem e recusado se um pacote atravessar `validation` e
`test`.

O conjunto de validacao escolhe `smallMax` e `largeMin`. O teste permanece
intocado ate a avaliacao final e nunca participa da escolha desses limiares.

## Gates padrao

| Metrica | Gate |
| --- | --- |
| `G` decidido como `P` | taxa igual a `0` |
| Precisao das decisoes `P` | pelo menos `0,98` |
| Recall de `G` | pelo menos `0,95` |
| Cobertura decisiva | pelo menos `0,65` |
| Resultado `uncertain` | no maximo `0,35` |
| Fronteira decidida como `P/G` | no maximo `0,10` |
| Confianca minima de uma decisao | `0,90` |

Ausencia de previsoes `P`, amostra insuficiente ou qualquer gate reprovado nao
gera checksum aprovado. O aplicativo continua em
`uncertain/model-not-installed` e oferece Entrega Manual.

## Arquivos e comandos

Os contratos, templates e exemplos de comandos estao em
[Pipeline do modelo P/G](../ml/package-size/README.md). A verificacao automatica
e executada por:

```bash
node scripts/package-dataset-calibration-test.mjs
```

Esse teste usa apenas metadados e scores sinteticos para validar a logica do
pipeline. Ele nao mede a qualidade de um modelo e nao pode ser citado como
evidencia para habilitar a Entrega Inteligente.

## Gate de conclusao

A Parte 5 so termina quando existirem:

- especificacao real e assinada das portas `P/G`;
- manifesto autorizado, validado e versionado sem imagens pessoais no Git;
- modelo TFLite reproduzivel e executavel no Android do locker;
- relatorio de validacao e teste aprovado por todos os gates;
- medicao de latencia no equipamento real;
- SHA-256 do artefato aprovado e registrado no Android.
