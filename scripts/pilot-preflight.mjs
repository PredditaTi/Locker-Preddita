import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePilotReadiness } from './pilotReadiness.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function readCandidateVersion() {
  const buildGradle = readFileSync(resolve(ROOT, 'android/app/build.gradle'), 'utf8');
  return buildGradle.match(/versionName\s+"([^"]+)"/)?.[1] || '';
}

function renderText(report, sourcePath) {
  const lines = [
    `Preflight do piloto: ${report.ready ? 'PRONTO' : 'BLOQUEADO'}`,
    `Estado: ${sourcePath}`,
    `Versao esperada: ${report.expectedVersion || 'qualquer versao identificada'}`,
    '',
  ];
  report.checks.forEach((check) => {
    lines.push(`${check.ok ? '[OK]' : '[BLOQUEIO]'} ${check.label}: ${check.detail}`);
  });
  lines.push('', `${report.readyCount}/${report.totalCount} verificacoes prontas.`);
  return lines.join('\n');
}

const stateArgument = readArgument('--state') || process.env.PREDDITA_PILOT_STATE_FILE || 'admin-online/data/state.json';
const statePath = resolve(ROOT, stateArgument);
const expectedVersion = readArgument('--expected-version') || process.env.PREDDITA_PILOT_EXPECTED_VERSION || readCandidateVersion();
const jsonOutput = process.argv.includes('--json');

let parsed;
try {
  parsed = JSON.parse(readFileSync(statePath, 'utf8'));
} catch (error) {
  console.error(`Nao foi possivel ler o estado do piloto em ${statePath}: ${error.message}`);
  process.exit(2);
}

const state = parsed.state && typeof parsed.state === 'object' ? parsed.state : parsed;
const report = evaluatePilotReadiness(state, {
  expectedVersion,
  deviceAuthMode: process.env.PREDDITA_DEVICE_AUTH_MODE,
  staleAfterMs: process.env.PREDDITA_DEVICE_STALE_MS,
});
console.log(jsonOutput ? JSON.stringify(report, null, 2) : renderText(report, statePath));
process.exit(report.ready ? 0 : 2);
