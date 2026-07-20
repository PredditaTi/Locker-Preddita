import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const ignoredDirectories = new Set([
  '.git',
  '.gradle',
  '.idea',
  'extraido-documents-rar',
  'backups',
  'node_modules',
  'build',
  'dist',
  'test-results',
  'playwright-report'
]);

function listMarkdownFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry)) continue;
    const absolute = join(directory, entry);
    const metadata = statSync(absolute);
    if (metadata.isDirectory()) {
      files.push(...listMarkdownFiles(absolute));
    } else if (entry.toLowerCase().endsWith('.md')) {
      files.push(absolute);
    }
  }
  return files;
}

function normalizeLocalTarget(rawTarget) {
  let target = rawTarget.trim();
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1);
  }
  if (/^(?:https?:|mailto:|data:|#)/i.test(target)) return null;
  target = target.replace(/\s+["'][^"']*["']\s*$/, '');
  target = target.split('#')[0].split('?')[0];
  if (!target) return null;
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function validateLinks(files) {
  const failures = [];
  let checked = 0;
  const markdownLink = /\[[^\]]*\]\(([^)]+)\)/g;

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(markdownLink)) {
      const target = normalizeLocalTarget(match[1]);
      if (!target) continue;
      checked += 1;
      const absoluteTarget = resolve(dirname(file), target);
      if (!existsSync(absoluteTarget)) {
        failures.push(`${relative(root, file)} -> ${target}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Links locais invalidos:\n${failures.join('\n')}`);
  }
  return checked;
}

function validateUpdatesPage() {
  const updatesPath = join(root, 'docs', 'UPDATES.md');
  const content = readFileSync(updatesPath, 'utf8');
  if (!content.includes('## Registro')) {
    throw new Error('docs/UPDATES.md precisa conter a secao "## Registro".');
  }
  if (!/^### \d{4}-\d{2}-\d{2} - .+$/m.test(content)) {
    throw new Error('docs/UPDATES.md precisa conter ao menos uma entrada datada.');
  }
}

function validateUpdateEntryForChangedDocs() {
  const explicitBase = process.env.PREDDITA_DOCS_BASE_REF?.trim();
  const githubBase = process.env.GITHUB_BASE_REF?.trim();
  const baseRef = explicitBase || (githubBase ? `origin/${githubBase}` : '');
  if (!baseRef) return [];

  const changed = execFileSync(
    'git',
    ['diff', '--name-only', baseRef, 'HEAD'],
    { cwd: root, encoding: 'utf8' }
  ).split(/\r?\n/).filter(Boolean);

  const documentationChanged = changed.filter((file) => {
    if (file === 'docs/UPDATES.md') return false;
    return file.toLowerCase().endsWith('.md')
      || /(^|\/)\.env(?:\.[^/]+)?\.example$/i.test(file);
  });

  if (
    documentationChanged.length > 0
    && !changed.includes('docs/UPDATES.md')
  ) {
    throw new Error(
      'Atualize docs/UPDATES.md ao alterar documentacao:\n'
      + documentationChanged.join('\n')
    );
  }
  return documentationChanged;
}

try {
  const markdownFiles = listMarkdownFiles(root);
  const links = validateLinks(markdownFiles);
  validateUpdatesPage();
  const changedDocs = validateUpdateEntryForChangedDocs();
  console.log(
    `Documentacao valida: ${markdownFiles.length} arquivos, ${links} links locais, `
    + `${changedDocs.length} arquivos documentais alterados.`
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
