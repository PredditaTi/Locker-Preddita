import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { bootKiosk } from './support/kioskTestBridge.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(scriptDirectory, '..');
const projectDirectory = path.resolve(webDirectory, '..');
const outputDirectory = path.join(projectDirectory, 'docs/assets/kiosk-v4-audio');
const port = Number(process.env.PREDDITA_AUDIO_PORT || 4178);
const baseUrl = `http://127.0.0.1:${port}`;
const viewports = [
  { name: '01-audio-1024x600', width: 1024, height: 600 },
  { name: '02-audio-390x844', width: 390, height: 844 },
];

async function waitForServer(server) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Servidor terminou com codigo ${server.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // The static server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Servidor de capturas nao respondeu em 6 segundos.');
}

await mkdir(outputDirectory, { recursive: true });
const server = spawn(process.execPath, [path.join(projectDirectory, 'scripts/serve-web.mjs')], {
  cwd: webDirectory,
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const browser = await chromium.launch({ headless: true });
const results = [];

try {
  await waitForServer(server);
  for (const viewport of viewports) {
    const context = await browser.newContext({
      baseURL: baseUrl,
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const browserErrors = await bootKiosk(page);
    await page.getByRole('button', { name: 'Configurar audio. Desativado' }).click();
    const dialog = page.getByRole('dialog', { name: 'Orientacao sonora' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Fechar audio' })).toBeFocused();
    await page.screenshot({ path: path.join(outputDirectory, `${viewport.name}.png`) });

    const geometry = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    });
    results.push({ viewport, geometry, browserErrors });
    await context.close();
  }

  const errors = results.flatMap((result) => result.browserErrors);
  if (errors.length > 0) throw new Error(`Erros no navegador: ${errors.join(' | ')}`);
  await writeFile(
    path.join(outputDirectory, 'metrics.json'),
    `${JSON.stringify({ capturedAt: new Date().toISOString(), results }, null, 2)}\n`,
    'utf8'
  );
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
