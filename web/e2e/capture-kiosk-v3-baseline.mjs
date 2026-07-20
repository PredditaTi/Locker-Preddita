import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import {
  bootKiosk,
  closeTestDoor,
} from './support/kioskTestBridge.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(scriptDirectory, '..');
const projectDirectory = path.resolve(webDirectory, '..');
const bundleDirectory = path.join(projectDirectory, 'android/app/src/main/assets/www');
const outputDirectory = path.join(projectDirectory, 'docs/assets/kiosk-v3-baseline');
const port = Number(process.env.PREDDITA_BASELINE_PORT || 4174);
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForServer(server) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Servidor de baseline terminou com codigo ${server.exitCode}.`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch (_error) {
      // O servidor ainda esta iniciando.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Servidor de baseline nao respondeu em 6 segundos.');
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

async function capture(page, name) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  await page.screenshot({
    path: path.join(outputDirectory, `${name}.png`),
  });
}

async function openDepositDoor(page) {
  await page.getByRole('button', { name: /Entregar encomenda/i }).click();
  await page.getByRole('textbox', { name: 'Apartamento', exact: true }).fill('203');
  await page.getByRole('button', { name: 'Apartamento 203', exact: true }).click();
  await page.getByRole('button', { name: 'Abrir porta', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Nao coube', exact: true })).toBeEnabled();
  const doorText = await page.locator('.public-door-hero strong').textContent();
  return Number(doorText?.match(/\d+/)?.[0]);
}

await mkdir(outputDirectory, { recursive: true });

const server = spawn(process.execPath, [path.join(projectDirectory, 'scripts/serve-web.mjs')], {
  cwd: webDirectory,
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const browser = await chromium.launch({ headless: true });

try {
  await waitForServer(server);
  const context = await browser.newContext({
    viewport: { width: 1024, height: 600 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const browserErrors = await bootKiosk(page, { url: baseUrl });
  await page.getByRole('button', { name: /Entregar encomenda/i }).waitFor();

  const firstScreen = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const paint = performance.getEntriesByName('first-contentful-paint')[0];
    return {
      readyMs: Math.round(performance.now() * 100) / 100,
      domContentLoadedMs: Math.round((navigation?.domContentLoadedEventEnd || 0) * 100) / 100,
      loadMs: Math.round((navigation?.loadEventEnd || 0) * 100) / 100,
      firstContentfulPaintMs: paint ? Math.round(paint.startTime * 100) / 100 : null,
    };
  });

  await capture(page, '01-inicio');
  await page.getByRole('button', { name: /Entregar encomenda/i }).click();
  await capture(page, '02-apartamento');
  await page.getByRole('textbox', { name: 'Apartamento', exact: true }).fill('203');
  await page.getByRole('button', { name: 'Apartamento 203', exact: true }).click();
  await capture(page, '03-confirmacao');
  await page.getByRole('button', { name: 'Abrir porta', exact: true }).click();
  const storedButton = page.getByRole('button', { name: 'Item guardado', exact: true });
  await expect(storedButton).toBeEnabled();
  const doorText = await page.locator('.public-door-hero strong').textContent();
  const depositDoor = Number(doorText?.match(/\d+/)?.[0]);
  await capture(page, '04-porta');
  await closeTestDoor(page, depositDoor);
  await storedButton.click();
  await page.getByRole('heading', { name: /Entrega salva|Entrega registrada/i }).waitFor();
  await capture(page, '05-sucesso');

  await page.getByRole('button', { name: 'Inicio', exact: true }).click();
  await page.getByRole('button', { name: /Retirar encomenda/i }).click();
  await capture(page, '06-pin');
  await page.getByRole('button', { name: 'Ler QR', exact: true }).click();
  await capture(page, '07-qr');
  await page.getByRole('button', { name: 'Usar PIN', exact: true }).click();
  for (const digit of '000000') {
    await page.locator('.public-number-pad--pin').getByRole('button', { name: digit, exact: true }).click();
  }
  await page.getByRole('alertdialog').waitFor();
  await capture(page, '08-erro');
  await context.close();

  const timeoutContext = await browser.newContext({
    viewport: { width: 1024, height: 600 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const timeoutPage = await timeoutContext.newPage();
  await timeoutPage.clock.install();
  const timeoutErrors = await bootKiosk(timeoutPage, { url: baseUrl });
  await openDepositDoor(timeoutPage);
  await timeoutPage.getByRole('button', { name: 'Nao coube', exact: true }).click();
  await timeoutPage.clock.runFor(61_000);
  await timeoutPage.getByRole('alertdialog').waitFor();
  await capture(timeoutPage, '09-timeout');
  await timeoutContext.close();

  const metrics = {
    capturedAt: new Date().toISOString(),
    viewport: { width: 1024, height: 600, deviceScaleFactor: 1 },
    firstScreen,
    bundle: await collectBundleMetrics(),
    consoleErrors: [...browserErrors, ...timeoutErrors],
  };
  await writeFile(
    path.join(outputDirectory, 'metrics.json'),
    `${JSON.stringify(metrics, null, 2)}\n`,
    'utf8'
  );
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
