const LABELS = new Set(['P', 'G', 'uncertain']);
const SPLITS = new Set(['validation', 'test']);

export function classifyProbability(probabilityG, thresholds) {
  if (!Number.isFinite(probabilityG) || probabilityG < 0 || probabilityG > 1) return 'uncertain';
  if (probabilityG <= thresholds.smallMax) return 'P';
  if (probabilityG >= thresholds.largeMin) return 'G';
  return 'uncertain';
}

export function validateScoreRows(rows) {
  const errors = [];
  const sampleIds = new Set();
  const packageSplits = new Map();
  if (!Array.isArray(rows) || rows.length === 0) return ['o arquivo de scores esta vazio'];
  rows.forEach((row, index) => {
    const prefix = `score ${index + 1}`;
    if (!String(row?.sampleId || '').trim()) errors.push(`${prefix}: sampleId ausente`);
    if (!String(row?.packageId || '').trim()) errors.push(`${prefix}: packageId ausente`);
    if (sampleIds.has(row?.sampleId)) errors.push(`${prefix}: sampleId duplicado`);
    sampleIds.add(row?.sampleId);
    if (!LABELS.has(row?.label)) errors.push(`${prefix}: label invalido`);
    if (!SPLITS.has(row?.split)) errors.push(`${prefix}: split deve ser validation ou test`);
    if (!Number.isFinite(row?.probabilityG) || row.probabilityG < 0 || row.probabilityG > 1) {
      errors.push(`${prefix}: probabilityG deve estar entre 0 e 1`);
    }
    const previousSplit = packageSplits.get(row?.packageId);
    if (previousSplit && previousSplit !== row?.split) {
      errors.push(`${prefix}: vazamento do pacote entre validation e test`);
    }
    packageSplits.set(row?.packageId, row?.split);
  });
  return errors;
}

export function calculateMetrics(rows, thresholds) {
  const counts = {
    total: rows.length,
    actualP: 0,
    actualG: 0,
    actualUncertain: 0,
    predictedP: 0,
    predictedG: 0,
    predictedUncertain: 0,
    correctP: 0,
    correctG: 0,
    falseSmall: 0,
    borderlineDecisive: 0
  };
  for (const row of rows) {
    const predicted = classifyProbability(row.probabilityG, thresholds);
    if (row.label === 'P') counts.actualP += 1;
    if (row.label === 'G') counts.actualG += 1;
    if (row.label === 'uncertain') counts.actualUncertain += 1;
    if (predicted === 'P') counts.predictedP += 1;
    if (predicted === 'G') counts.predictedG += 1;
    if (predicted === 'uncertain') counts.predictedUncertain += 1;
    if (row.label === 'P' && predicted === 'P') counts.correctP += 1;
    if (row.label === 'G' && predicted === 'G') counts.correctG += 1;
    if (row.label === 'G' && predicted === 'P') counts.falseSmall += 1;
    if (row.label === 'uncertain' && predicted !== 'uncertain') counts.borderlineDecisive += 1;
  }
  const ratio = (numerator, denominator) => denominator > 0 ? numerator / denominator : 0;
  const decisive = counts.predictedP + counts.predictedG;
  return {
    ...counts,
    coverage: ratio(decisive, counts.total),
    uncertainRate: ratio(counts.predictedUncertain, counts.total),
    falseSmallRate: ratio(counts.falseSmall, counts.actualG),
    smallPrecision: ratio(counts.correctP, counts.predictedP),
    largeRecall: ratio(counts.correctG, counts.actualG),
    borderlineDecisiveRate: ratio(counts.borderlineDecisive, counts.actualUncertain),
    decisiveAccuracy: ratio(counts.correctP + counts.correctG, decisive)
  };
}

function packageCounts(rows) {
  const byLabel = { P: new Set(), G: new Set(), uncertain: new Set() };
  for (const row of rows) byLabel[row.label]?.add(row.packageId);
  return {
    P: byLabel.P.size,
    G: byLabel.G.size,
    uncertain: byLabel.uncertain.size
  };
}

export function evaluateGates(rows, metrics, policy) {
  const gates = policy.gates;
  const packages = packageCounts(rows);
  const checks = {
    falseSmallRate: metrics.falseSmallRate <= gates.maxFalseSmallRate,
    smallPrecision: metrics.smallPrecision >= gates.minSmallPrecision,
    largeRecall: metrics.largeRecall >= gates.minLargeRecall,
    coverage: metrics.coverage >= gates.minCoverage,
    uncertainRate: metrics.uncertainRate <= gates.maxUncertainRate,
    borderlineDecisiveRate: metrics.borderlineDecisiveRate <= gates.maxBorderlineDecisiveRate,
    packageCountP: packages.P >= gates.minPackagesPerLabel,
    packageCountG: packages.G >= gates.minPackagesPerLabel,
    borderlinePackageCount: packages.uncertain >= gates.minBorderlinePackages
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    packages
  };
}

function candidateThresholds(policy) {
  const minimumConfidence = policy.decision.minimumConfidence;
  const step = policy.decision.thresholdStep;
  if (
    !Number.isFinite(minimumConfidence)
      || minimumConfidence < 0.5
      || minimumConfidence > 1
      || !Number.isFinite(step)
      || step <= 0
      || step > 0.1
  ) {
    throw new Error('Politica de decisao invalida');
  }
  const candidates = [];
  const smallLimit = 1 - minimumConfidence;
  for (let small = 0; small <= smallLimit + 1e-9; small += step) {
    for (let large = minimumConfidence; large <= 1 + 1e-9; large += step) {
      candidates.push({
        smallMax: Number(small.toFixed(6)),
        largeMin: Number(Math.min(1, large).toFixed(6))
      });
    }
  }
  return candidates;
}

function compareCandidates(left, right) {
  return right.metrics.coverage - left.metrics.coverage
    || right.metrics.smallPrecision - left.metrics.smallPrecision
    || right.metrics.largeRecall - left.metrics.largeRecall
    || left.metrics.falseSmallRate - right.metrics.falseSmallRate
    || right.thresholds.smallMax - left.thresholds.smallMax
    || left.thresholds.largeMin - right.thresholds.largeMin;
}

export function calibrateScores(rows, policy) {
  const errors = validateScoreRows(rows);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  const validationRows = rows.filter((row) => row.split === 'validation');
  const testRows = rows.filter((row) => row.split === 'test');
  if (validationRows.length === 0 || testRows.length === 0) {
    throw new Error('Scores precisam conter validation e test');
  }

  const eligible = candidateThresholds(policy).map((thresholds) => {
    const metrics = calculateMetrics(validationRows, thresholds);
    return { thresholds, metrics, gates: evaluateGates(validationRows, metrics, policy) };
  }).filter((candidate) => candidate.gates.passed).sort(compareCandidates);

  if (eligible.length === 0) {
    return {
      schemaVersion: 1,
      approved: false,
      reason: 'no-validation-threshold-passed',
      thresholds: null,
      validation: null,
      test: null
    };
  }

  const selected = eligible[0];
  const testMetrics = calculateMetrics(testRows, selected.thresholds);
  const testGates = evaluateGates(testRows, testMetrics, policy);
  return {
    schemaVersion: 1,
    approved: selected.gates.passed && testGates.passed,
    reason: testGates.passed ? 'all-gates-passed' : 'test-gates-failed',
    thresholds: selected.thresholds,
    validation: { metrics: selected.metrics, gates: selected.gates },
    test: { metrics: testMetrics, gates: testGates }
  };
}
