# Pipeline do modelo P/G

Esta pasta contem a infraestrutura reprodutivel da Parte 5 da Entrega
Inteligente. Ela nao contem fotos reais nem um modelo aprovado.

## Fontes de verdade

- `door-spec.template.json`: campos que precisam ser medidos no armario real;
- `dataset-record.schema.json`: contrato de cada imagem autorizada;
- `calibration-policy.json`: gates minimos para uma versao candidata;
- `datasetPipeline.mjs`: rotulo por medidas, validacao e split por pacote;
- `calibration.mjs`: selecao de limiares usando validacao e avaliacao final no
  teste intocado;
- `model-release.template.json`: metadados obrigatorios do futuro TFLite.

`dataset/images/`, `dataset/raw/` e `artifacts/` sao ignorados pelo Git. Fotos
de etiquetas nao podem ser versionadas. O manifesto tambem so pode referenciar
imagens revisadas nas quais nome, endereco, telefone, codigo de rastreio, QR e
codigo de barras nao estejam legiveis.

## Ordem de execucao

1. Copie `door-spec.template.json` para `door-spec.json` e preencha todas as
   medidas internas uteis em milimetros.
2. Valide as medidas:

   ```bash
   node scripts/package-model-pipeline.mjs validate-door \
     --door-spec ml/package-size/door-spec.json
   ```

3. Crie `dataset/manifest.jsonl`, uma linha JSON por imagem, de acordo com
   `dataset-record.schema.json`.
4. Valide metadados, arquivos e hashes:

   ```bash
   node scripts/package-model-pipeline.mjs validate \
     --manifest ml/package-size/dataset/manifest.jsonl \
     --door-spec ml/package-size/door-spec.json \
     --require-images true
   ```

5. Gere o split deterministico. Todas as vistas do mesmo pacote ficam no mesmo
   grupo:

   ```bash
   node scripts/package-model-pipeline.mjs split \
     --manifest ml/package-size/dataset/manifest.jsonl \
     --door-spec ml/package-size/door-spec.json \
     --output ml/package-size/dataset/manifest-split.jsonl
   ```

6. Depois do treinamento, exporte uma linha por inferencia com `sampleId`,
   `packageId`, `label`, `split` e `probabilityG`. Calibre sem usar o teste para
   escolher os limiares:

   ```bash
   node scripts/package-model-pipeline.mjs calibrate \
     --scores ml/package-size/dataset/scores.jsonl \
     --policy ml/package-size/calibration-policy.json \
     --output ml/package-size/calibration-report.json
   ```

O processo retorna codigo `2` quando o relatorio e valido, mas algum gate nao
foi atingido. Nenhum checksum deve ser copiado para o Android nesse caso.

## Rotulagem

O rotulo vem das medidas, considerando as seis orientacoes de um pacote
retangular e a menor dimensao entre abertura e compartimento. A folga minima e
subtraida da capacidade da porta:

- `P`: cabe na porta pequena com folga;
- `G`: nao cabe na pequena e cabe na grande com folga;
- `uncertain`: esta na faixa de folga de uma das portas ou excede a grande.

Exemplos `uncertain` pertencem ao conjunto de avaliacao. O calibrador reprova
um modelo que transforme mais de 10% deles em decisoes definitivas.

## Limite atual

Uma unica foto sem referencia geometrica nao prova profundidade ou escala. A
coleta deve usar a camera, posicao e guia visual do armario real. Se a variacao
de distancia impedir os gates, a solucao deve ganhar uma referencia fisica de
escala ou uma segunda vista; nao se reduz o gate de falso `P` para compensar.
