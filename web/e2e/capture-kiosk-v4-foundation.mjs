import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { installRs485Bridge } from './support/kioskTestBridge.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(scriptDirectory, '..');
const projectDirectory = path.resolve(webDirectory, '..');
const bundleDirectory = path.join(projectDirectory, 'android/app/src/main/assets/www');
const outputDirectory = path.join(projectDirectory, 'docs/assets/kiosk-v4-foundation');
const port = Number(process.env.PREDDITA_V4_PORT || 4175);
const baseUrl = `http://127.0.0.1:${port}`;

const homeViewports = [
  { name: 'home-1024x600', width: 1024, height: 600 },
  { name: 'home-1280x800', width: 1280, height: 800 },
  { name: 'home-800x480', width: 800, height: 480 },
  { name: 'home-390x844', width: 390, height: 844 },
];

const prototypeStages = [
  { name: 'prototype-01-home', stage: 'home', selector: '.kiosk-v4-home' },
  { name: 'prototype-02-apartment', stage: 'apartment', selector: '.kiosk-v4-prototype--apartment' },
  { name: 'prototype-03-door', stage: 'door', selector: '.kiosk-v4-prototype--door' },
  { name: 'prototype-04-pin', stage: 'pin', selector: '.kiosk-v4-prototype--pin' },
  { name: 'prototype-05-success', stage: 'success', selector: '.kiosk-v4-prototype--success' },
];

async function waitForServer(server) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Servidor V4 terminou com codigo ${server.exitCode}.`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch (_error) {
      // O servidor ainda esta iniciando.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Servidor V4 nao respondeu em 6 segundos.');
}

async function settle(page, selector) {
  await page.locator(selector).waitFor();
  await page.locator('.kiosk-v4-brand').waitFor();
  await page.locator('.kiosk-v4-topbar-actions').waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function collectBundleMetrics() {
  const assetDirectory = path.join(bundleDirectory, 'assets');
  const assetNames = await readdir(assetDirectory);
  const files = ['index.html', ...assetNames.map((name) => `assets/${name}`)];
  const metrics = [];

  for (const relativePath of files.sort()) {
    const absolutePath = path.join(bundleDirectory, relativePath);
    const contents = await readFile(absolutePath);
    const fileStats = await stat(absolutePath);
    metrics.push({
      path: relativePath,
      bytes: fileStats.size,
      gzipBytes: gzipSync(contents).length,
    });
  }

  return {
    totalBytes: metrics.reduce((sum, file) => sum + file.bytes, 0),
    totalGzipBytes: metrics.reduce((sum, file) => sum + file.gzipBytes, 0),
    files: metrics,
  };
}

async function newPage(browser, viewport, browserErrors) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.addInitScript(installRs485Bridge);
  return { context, page };
}

await mkdir(outputDirectory, { recursive: true });

const server = spawn(process.execPath, [path.join(projectDirectory, 'scripts/serve-web.mjs')], {
  cwd: webDirectory,
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const browser = await chromium.launch({ headless: true });
const browserErrors = [];

try {
  await waitForServer(server);

  for (const viewport of homeViewports) {
    const { context, page } = await newPage(browser, { width: viewport.width, height: viewport.height }, browserErrors);
    await page.goto(baseUrl);
    await settle(page, '.kiosk-v4-home');
    await page.screenshot({ path: path.join(outputDirectory, `${viewport.name}.png`) });
    await context.close();
  }

  for (const prototype of prototypeStages) {
    const { context, page } = await newPage(browser, { width: 1024, height: 600 }, browserErrors);
    await page.goto(`${baseUrl}/?kioskPrototype=${prototype.stage}`);
    await settle(page, prototype.selector);
    await page.screenshot({ path: path.join(outputDirectory, `${prototype.name}.png`) });
    await context.close();
  }

  const metrics = {
    capturedAt: new Date().toISOString(),
    homeViewports: homeViewports.map(({ name, width, height }) => ({ name, width, height })),
    prototypeViewport: { width: 1024, height: 600, deviceScaleFactor: 1 },
    bundle: await collectBundleMetrics(),
    consoleErrors: browserErrors,
  };
  await writeFile(path.join(outputDirectory, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
