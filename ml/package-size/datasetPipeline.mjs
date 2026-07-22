import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { extname, isAbsolute, resolve, sep } from 'node:path';

export const DATASET_SCHEMA_VERSION = 1;
export const DATASET_LABELS = Object.freeze(['P', 'G', 'uncertain']);
export const DATASET_SPLITS = Object.freeze(['train', 'validation', 'test']);

const CAPTURE_VIEWS = new Set(['front', 'left', 'right', 'top', 'oblique']);
const LIGHTING_VALUES = new Set(['indoor-even', 'indoor-low', 'backlit', 'mixed']);
const PACKAGING_VALUES = new Set(['cardboard', 'plastic-mailer', 'paper', 'other']);
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RECORD_FIELDS = new Set([
  'schemaVersion',
  'sampleId',
  'packageId',
  'imagePath',
  'imageSha256',
  'label',
  'split',
  'dimensionsMm',
  'capture',
  'quality',
  'privacy'
]);

function isFinitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

function addError(errors, index, message) {
  errors.push(`registro ${index + 1}: ${message}`);
}

function rejectUnknownFields(errors, index, value, allowed, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addError(errors, index, `${fieldName}.${key} nao pertence ao contrato`);
  }
}

function dimensionsArray(dimensions) {
  return [dimensions?.width, dimensions?.height, dimensions?.depth];
}

function permutations(values) {
  const [a, b, c] = values;
  return [
    [a, b, c],
    [a, c, b],
    [b, a, c],
    [b, c, a],
    [c, a, b],
    [c, b, a]
  ];
}

export function validateDoorSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return { valid: false, errors: ['especificacao ausente'] };
  if (spec.schemaVersion !== 1) errors.push('schemaVersion da porta deve ser 1');
  if (!String(spec.specVersion || '').trim() || spec.specVersion === 'MEASURE-AND-REPLACE') {
    errors.push('specVersion precisa identificar uma medicao real');
  }
  if (!String(spec.measuredAt || '').trim()) errors.push('measuredAt e obrigatorio');
  if (!isFinitePositive(spec.minimumClearanceMm)) {
    errors.push('minimumClearanceMm deve ser maior que zero');
  }

  for (const size of ['P', 'G']) {
    const door = spec.doors?.[size];
    for (const [section, fields] of [
      ['opening', ['widthMm', 'heightMm']],
      ['compartment', ['widthMm', 'heightMm', 'depthMm']]
    ]) {
      for (const field of fields) {
        if (!isFinitePositive(door?.[section]?.[field])) {
          errors.push(`doors.${size}.${section}.${field} deve ser medido em milimetros`);
        }
      }
    }
  }

  if (errors.length === 0) {
    const small = usableDoorDimensions(spec.doors.P);
    const large = usableDoorDimensions(spec.doors.G);
    if (
      large.some((value, index) => value < small[index])
        || !large.some((value, index) => value > small[index])
    ) {
      errors.push('a porta G nao pode ser menor que P e precisa ser maior em ao menos um eixo');
    }
  }

  return { valid: errors.length === 0, errors };
}

export function usableDoorDimensions(door) {
  return [
    Math.min(door.opening.widthMm, door.compartment.widthMm),
    Math.min(door.opening.heightMm, door.compartment.heightMm),
    door.compartment.depthMm
  ];
}

export function fitsDoor(dimensions, door, clearanceMm = 0) {
  const parcel = dimensionsArray(dimensions);
  if (!parcel.every(isFinitePositive) || !Number.isFinite(clearanceMm) || clearanceMm < 0) {
    return false;
  }
  const usable = usableDoorDimensions(door);
  return permutations(parcel).some((orientation) => orientation.every(
    (value, index) => value + clearanceMm <= usable[index]
  ));
}

export function derivePackageLabel(dimensions, doorSpec) {
  const validation = validateDoorSpec(doorSpec);
  if (!validation.valid) {
    throw new Error(`Especificacao de portas invalida: ${validation.errors.join('; ')}`);
  }
  const clearance = doorSpec.minimumClearanceMm;
  if (fitsDoor(dimensions, doorSpec.doors.P, clearance)) {
    return { label: 'P', reason: 'fits-small-with-clearance' };
  }
  if (fitsDoor(dimensions, doorSpec.doors.P, 0)) {
    return { label: 'uncertain', reason: 'small-boundary-zone' };
  }
  if (fitsDoor(dimensions, doorSpec.doors.G, clearance)) {
    return { label: 'G', reason: 'fits-large-with-clearance' };
  }
  if (fitsDoor(dimensions, doorSpec.doors.G, 0)) {
    return { label: 'uncertain', reason: 'large-boundary-zone' };
  }
  return { label: 'uncertain', reason: 'oversize-or-unsupported' };
}

function validateRelativeImagePath(imagePath) {
  if (typeof imagePath !== 'string' || !imagePath.startsWith('images/')) return false;
  if (isAbsolute(imagePath) || imagePath.split('/').includes('..')) return false;
  return ['.jpg', '.jpeg'].includes(extname(imagePath).toLowerCase());
}

function sameDimensions(left, right) {
  return dimensionsArray(left).every((value, index) => value === dimensionsArray(right)[index]);
}

export function validateDataset(records, doorSpec, options = {}) {
  const errors = [];
  const specValidation = validateDoorSpec(doorSpec);
  errors.push(...specValidation.errors.map((error) => `portas: ${error}`));
  if (!Array.isArray(records) || records.length === 0) {
    errors.push('o manifesto precisa conter ao menos um registro');
    return { valid: false, errors, stats: emptyDatasetStats() };
  }

  const sampleIds = new Set();
  const imageHashes = new Set();
  const packages = new Map();
  const labels = { P: 0, G: 0, uncertain: 0 };
  const splits = { train: 0, validation: 0, test: 0, unassigned: 0 };

  records.forEach((record, index) => {
    if (!record || typeof record !== 'object') {
      addError(errors, index, 'deve ser um objeto JSON');
      return;
    }
    rejectUnknownFields(errors, index, record, RECORD_FIELDS, 'record');
    rejectUnknownFields(
      errors,
      index,
      record.dimensionsMm,
      new Set(['width', 'height', 'depth']),
      'dimensionsMm'
    );
    rejectUnknownFields(
      errors,
      index,
      record.capture,
      new Set(['view', 'lighting', 'packaging', 'deviceModel']),
      'capture'
    );
    rejectUnknownFields(errors, index, record.quality, new Set(['accepted', 'score']), 'quality');
    rejectUnknownFields(
      errors,
      index,
      record.privacy,
      new Set(['reviewed', 'personalDataVisible', 'redactionApplied']),
      'privacy'
    );
    if (record.schemaVersion !== DATASET_SCHEMA_VERSION) addError(errors, index, 'schemaVersion deve ser 1');
    if (!ID_PATTERN.test(record.sampleId || '')) addError(errors, index, 'sampleId invalido');
    if (!ID_PATTERN.test(record.packageId || '')) addError(errors, index, 'packageId invalido');
    if (sampleIds.has(record.sampleId)) addError(errors, index, `sampleId duplicado: ${record.sampleId}`);
    sampleIds.add(record.sampleId);
    if (!validateRelativeImagePath(record.imagePath)) addError(errors, index, 'imagePath deve apontar para images/*.jpg sem travessia');
    if (!SHA256_PATTERN.test(record.imageSha256 || '')) addError(errors, index, 'imageSha256 invalido');
    if (imageHashes.has(record.imageSha256)) addError(errors, index, 'imagem duplicada pelo SHA-256');
    imageHashes.add(record.imageSha256);
    if (!DATASET_LABELS.includes(record.label)) addError(errors, index, 'label deve ser P, G ou uncertain');
    else labels[record.label] += 1;
    if (record.split === undefined) splits.unassigned += 1;
    else if (!DATASET_SPLITS.includes(record.split)) addError(errors, index, 'split invalido');
    else splits[record.split] += 1;

    if (!dimensionsArray(record.dimensionsMm).every(isFinitePositive)) {
      addError(errors, index, 'dimensionsMm deve conter width, height e depth positivos');
    } else if (specValidation.valid) {
      const derived = derivePackageLabel(record.dimensionsMm, doorSpec);
      if (record.label !== derived.label) {
        addError(errors, index, `label ${record.label} diverge da medida: ${derived.label}/${derived.reason}`);
      }
    }

    if (!CAPTURE_VIEWS.has(record.capture?.view)) addError(errors, index, 'capture.view invalido');
    if (!LIGHTING_VALUES.has(record.capture?.lighting)) addError(errors, index, 'capture.lighting invalido');
    if (!PACKAGING_VALUES.has(record.capture?.packaging)) addError(errors, index, 'capture.packaging invalido');
    if (!String(record.capture?.deviceModel || '').trim()) addError(errors, index, 'capture.deviceModel e obrigatorio');
    if (record.quality?.accepted !== true) addError(errors, index, 'quality.accepted deve ser true');
    if (!Number.isFinite(record.quality?.score) || record.quality.score < 0 || record.quality.score > 1) {
      addError(errors, index, 'quality.score deve estar entre 0 e 1');
    }
    if (record.privacy?.reviewed !== true) addError(errors, index, 'privacy.reviewed deve ser true');
    if (record.privacy?.personalDataVisible !== false) {
      addError(errors, index, 'imagens com dados pessoais visiveis sao proibidas');
    }
    if (
      record.privacy?.redactionApplied !== undefined
        && typeof record.privacy.redactionApplied !== 'boolean'
    ) {
      addError(errors, index, 'privacy.redactionApplied deve ser booleano');
    }

    const previous = packages.get(record.packageId);
    if (previous) {
      if (previous.label !== record.label) addError(errors, index, 'o mesmo pacote possui labels diferentes');
      if (!sameDimensions(previous.dimensionsMm, record.dimensionsMm)) {
        addError(errors, index, 'o mesmo pacote possui medidas diferentes');
      }
      if (previous.split && record.split && previous.split !== record.split) {
        addError(errors, index, 'vazamento: o mesmo pacote aparece em splits diferentes');
      }
      if (!previous.split && record.split) previous.split = record.split;
    } else {
      packages.set(record.packageId, {
        label: record.label,
        dimensionsMm: record.dimensionsMm,
        split: record.split
      });
    }

    if (options.requireImages && validateRelativeImagePath(record.imagePath)) {
      const manifestDirectory = resolve(options.manifestDirectory || '.');
      const imageFile = resolve(manifestDirectory, record.imagePath);
      if (!imageFile.startsWith(`${manifestDirectory}${sep}`) || !existsSync(imageFile)) {
        addError(errors, index, `imagem inexistente: ${record.imagePath}`);
      } else {
        const digest = createHash('sha256').update(readFileSync(imageFile)).digest('hex');
        if (digest !== record.imageSha256) addError(errors, index, 'SHA-256 da imagem nao confere');
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    stats: { samples: records.length, packages: packages.size, labels, splits }
  };
}

function emptyDatasetStats() {
  return {
    samples: 0,
    packages: 0,
    labels: { P: 0, G: 0, uncertain: 0 },
    splits: { train: 0, validation: 0, test: 0, unassigned: 0 }
  };
}

function stableHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function splitCounts(total, ratios) {
  let validation = Math.round(total * ratios.validation);
  let test = Math.round(total * ratios.test);
  if (total >= 3 && ratios.validation > 0) validation = Math.max(1, validation);
  if (total >= 3 && ratios.test > 0) test = Math.max(1, test);
  while (validation + test >= total && (validation > 0 || test > 0)) {
    if (test >= validation && test > 0) test -= 1;
    else validation -= 1;
  }
  return { train: total - validation - test, validation, test };
}

export function assignDatasetSplits(records, options = {}) {
  const ratios = {
    validation: options.validationRatio ?? 0.2,
    test: options.testRatio ?? 0.2
  };
  if (
    !Number.isFinite(ratios.validation)
      || !Number.isFinite(ratios.test)
      || ratios.validation < 0
      || ratios.test < 0
      || ratios.validation + ratios.test >= 1
  ) {
    throw new Error('Ratios de split invalidos');
  }
  const seed = String(options.seed || 'preddita-package-size-v1');
  const packageById = new Map();
  for (const record of records) {
    const previous = packageById.get(record.packageId);
    if (previous && previous.label !== record.label) {
      throw new Error(`Pacote ${record.packageId} possui labels diferentes`);
    }
    packageById.set(record.packageId, { packageId: record.packageId, label: record.label });
  }

  const splitByPackage = new Map();
  for (const label of DATASET_LABELS) {
    const groups = [...packageById.values()]
      .filter((item) => item.label === label)
      .sort((left, right) => {
        const compared = stableHash(`${seed}:${left.packageId}`).localeCompare(stableHash(`${seed}:${right.packageId}`));
        return compared || left.packageId.localeCompare(right.packageId);
      });
    const counts = splitCounts(groups.length, ratios);
    groups.forEach((item, index) => {
      const split = index < counts.train
        ? 'train'
        : index < counts.train + counts.validation
          ? 'validation'
          : 'test';
      splitByPackage.set(item.packageId, split);
    });
  }

  return records.map((record) => ({ ...record, split: splitByPackage.get(record.packageId) }));
}

export function parseJsonLines(content, source = 'manifesto') {
  const records = [];
  String(content).split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    try {
      records.push(JSON.parse(trimmed));
    } catch (error) {
      throw new Error(`${source}:${index + 1}: JSON invalido`);
    }
  });
  return records;
}

export function stringifyJsonLines(records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}
