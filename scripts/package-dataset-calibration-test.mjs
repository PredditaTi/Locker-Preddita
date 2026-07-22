import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  assignDatasetSplits,
  derivePackageLabel,
  fitsDoor,
  validateDataset,
  validateDoorSpec
} from '../ml/package-size/datasetPipeline.mjs';
import {
  calculateMetrics,
  calibrateScores,
  classifyProbability,
  validateScoreRows
} from '../ml/package-size/calibration.mjs';

let assertions = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

const doorSpec = {
  schemaVersion: 1,
  specVersion: 'fixture-v1',
  measuredAt: '2026-07-22',
  measurementMethod: 'test-fixture',
  minimumClearanceMm: 20,
  doors: {
    P: {
      opening: { widthMm: 400, heightMm: 500 },
      compartment: { widthMm: 420, heightMm: 520, depthMm: 500 }
    },
    G: {
      opening: { widthMm: 600, heightMm: 800 },
      compartment: { widthMm: 620, heightMm: 820, depthMm: 600 }
    }
  }
};

check(validateDoorSpec(doorSpec).valid, true, 'a fixture de portas deve ser valida');
check(
  fitsDoor({ width: 480, height: 350, depth: 350 }, doorSpec.doors.P, 0),
  true,
  'o teste de encaixe deve considerar rotacao do pacote'
);
check(
  derivePackageLabel({ width: 300, height: 300, depth: 300 }, doorSpec).label,
  'P',
  'pacote com folga deve receber P'
);
check(
  derivePackageLabel({ width: 490, height: 390, depth: 390 }, doorSpec).label,
  'uncertain',
  'pacote na faixa de folga da porta P deve ficar incerto'
);
check(
  derivePackageLabel({ width: 550, height: 700, depth: 500 }, doorSpec).label,
  'G',
  'pacote que nao cabe em P e cabe com folga em G deve receber G'
);
check(
  derivePackageLabel({ width: 590, height: 790, depth: 590 }, doorSpec).label,
  'uncertain',
  'pacote na faixa de folga da porta G deve ficar incerto'
);

const dimensionsByLabel = {
  P: { width: 300, height: 300, depth: 300 },
  G: { width: 550, height: 700, depth: 500 },
  uncertain: { width: 490, height: 390, depth: 390 }
};

function datasetRecord(label, packageIndex, viewIndex) {
  const packageId = `pkg-${label.toLowerCase()}-${packageIndex}`;
  const sampleId = `${packageId}-view-${viewIndex}`;
  return {
    schemaVersion: 1,
    sampleId,
    packageId,
    imagePath: `images/${sampleId}.jpg`,
    imageSha256: createHash('sha256').update(sampleId).digest('hex'),
    label,
    dimensionsMm: dimensionsByLabel[label],
    capture: {
      view: viewIndex === 1 ? 'front' : 'oblique',
      lighting: 'indoor-even',
      packaging: 'cardboard',
      deviceModel: 'fixture-camera'
    },
    quality: { accepted: true, score: 0.95 },
    privacy: { reviewed: true, personalDataVisible: false, redactionApplied: true }
  };
}

const records = [];
for (const label of ['P', 'G', 'uncertain']) {
  for (let packageIndex = 1; packageIndex <= 6; packageIndex += 1) {
    records.push(datasetRecord(label, packageIndex, 1));
    records.push(datasetRecord(label, packageIndex, 2));
  }
}

check(validateDataset(records, doorSpec).valid, true, 'dataset coerente deve ser aceito');
const splitRecords = assignDatasetSplits(records, { seed: 'deterministic-fixture' });
check(validateDataset(splitRecords, doorSpec).valid, true, 'dataset separado deve permanecer valido');
const packageSplits = new Map();
for (const record of splitRecords) {
  const previous = packageSplits.get(record.packageId);
  if (previous) check(record.split, previous, 'todas as fotos do pacote devem permanecer no mesmo split');
  packageSplits.set(record.packageId, record.split);
}
check(
  assignDatasetSplits(records, { seed: 'deterministic-fixture' }),
  splitRecords,
  'o split deve ser reprodutivel com a mesma seed'
);

const privateRecord = structuredClone(records[0]);
privateRecord.privacy.personalDataVisible = true;
check(
  validateDataset([privateRecord], doorSpec).errors.some((error) => error.includes('dados pessoais')),
  true,
  'imagem com dado pessoal visivel deve ser recusada'
);

const extraDataRecord = structuredClone(records[0]);
extraDataRecord.recipientName = 'campo proibido';
check(
  validateDataset([extraDataRecord], doorSpec).errors.some((error) => error.includes('nao pertence ao contrato')),
  true,
  'campos extras devem ser recusados para evitar dados pessoais fora do contrato'
);

const policy = {
  schemaVersion: 1,
  decision: { minimumConfidence: 0.9, thresholdStep: 0.01 },
  gates: {
    maxFalseSmallRate: 0,
    minSmallPrecision: 1,
    minLargeRecall: 1,
    minCoverage: 0.65,
    maxUncertainRate: 0.35,
    maxBorderlineDecisiveRate: 0,
    minPackagesPerLabel: 3,
    minBorderlinePackages: 3
  }
};

function scoreRows(split, scores) {
  return Object.entries(scores).flatMap(([label, values]) => values.map((probabilityG, index) => ({
    sampleId: `${split}-${label}-${index}`,
    packageId: `${split}-pkg-${label}-${index}`,
    label,
    split,
    probabilityG
  })));
}

const validationScores = scoreRows('validation', {
  P: [0.01, 0.04, 0.08],
  G: [0.92, 0.96, 0.99],
  uncertain: [0.4, 0.5, 0.6]
});
const testScores = scoreRows('test', {
  P: [0.02, 0.05, 0.07],
  G: [0.93, 0.97, 0.98],
  uncertain: [0.35, 0.52, 0.7]
});

check(validateScoreRows([...validationScores, ...testScores]), [], 'scores validos devem passar');
const approved = calibrateScores([...validationScores, ...testScores], policy);
check(approved.approved, true, 'calibracao segura deve ser aprovada');
check(approved.test.metrics.falseSmall, 0, 'calibracao aprovada nao pode conter falso P');
check(classifyProbability(0.5, approved.thresholds), 'uncertain', 'zona central deve ser incerta');

const unsafeTest = testScores.map((row, index) => index === 3 ? { ...row, probabilityG: 0.01 } : row);
const rejected = calibrateScores([...validationScores, ...unsafeTest], policy);
check(rejected.approved, false, 'um pacote G classificado P deve reprovar o relatorio');
check(rejected.reason, 'test-gates-failed', 'a reprovacao deve ocorrer somente no teste intocado');
check(rejected.test.metrics.falseSmall, 1, 'o relatorio deve contar o erro perigoso');

const metrics = calculateMetrics(unsafeTest, approved.thresholds);
check(metrics.falseSmallRate > 0, true, 'a metrica deve expor taxa de falso P');

process.stdout.write(`Dataset e calibracao P/G: ${assertions} verificacoes aprovadas.\n`);
