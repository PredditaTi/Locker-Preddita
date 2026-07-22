#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  assignDatasetSplits,
  parseJsonLines,
  stringifyJsonLines,
  validateDataset,
  validateDoorSpec
} from '../ml/package-size/datasetPipeline.mjs';
import { calibrateScores } from '../ml/package-size/calibration.mjs';

function parseArguments(values) {
  const [command, ...rest] = values;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith('--') || value === undefined) throw new Error(`Argumento invalido: ${name || ''}`);
    options[name.slice(2)] = value;
  }
  return { command, options };
}

function required(options, name) {
  const value = options[name];
  if (!value) throw new Error(`Informe --${name}`);
  return resolve(value);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  process.stdout.write([
    'Uso:',
    '  node scripts/package-model-pipeline.mjs validate-door --door-spec <arquivo>',
    '  node scripts/package-model-pipeline.mjs validate --manifest <jsonl> --door-spec <json>',
    '  node scripts/package-model-pipeline.mjs split --manifest <jsonl> --door-spec <json> --output <jsonl>',
    '  node scripts/package-model-pipeline.mjs calibrate --scores <jsonl> --policy <json> --output <json>',
    ''
  ].join('\n'));
}

try {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (!command || command === 'help') {
    usage();
    process.exit(0);
  }
  if (command === 'validate-door') {
    const result = validateDoorSpec(readJson(required(options, 'door-spec')));
    printJson(result);
    if (!result.valid) process.exitCode = 1;
  } else if (command === 'validate' || command === 'split') {
    const manifestPath = required(options, 'manifest');
    const doorSpec = readJson(required(options, 'door-spec'));
    const records = parseJsonLines(readFileSync(manifestPath, 'utf8'), manifestPath);
    const result = validateDataset(records, doorSpec, {
      requireImages: options['require-images'] === 'true',
      manifestDirectory: dirname(manifestPath)
    });
    if (!result.valid) {
      printJson(result);
      process.exitCode = 1;
    } else if (command === 'validate') {
      printJson(result);
    } else {
      const output = required(options, 'output');
      const splitRecords = assignDatasetSplits(records, {
        seed: options.seed,
        validationRatio: options.validation ? Number(options.validation) : undefined,
        testRatio: options.test ? Number(options.test) : undefined
      });
      const splitValidation = validateDataset(splitRecords, doorSpec);
      if (!splitValidation.valid) throw new Error(splitValidation.errors.join('\n'));
      writeFileSync(output, stringifyJsonLines(splitRecords), 'utf8');
      printJson({ valid: true, output, stats: splitValidation.stats });
    }
  } else if (command === 'calibrate') {
    const scorePath = required(options, 'scores');
    const scores = parseJsonLines(readFileSync(scorePath, 'utf8'), scorePath);
    const report = calibrateScores(scores, readJson(required(options, 'policy')));
    const output = required(options, 'output');
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    printJson({ output, approved: report.approved, reason: report.reason, thresholds: report.thresholds });
    if (!report.approved) process.exitCode = 2;
  } else {
    throw new Error(`Comando desconhecido: ${command}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  usage();
  process.exitCode = 1;
}
