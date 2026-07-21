import { expect, test } from '@playwright/test';
import {
  bootKiosk,
  closeTestDoor,
  readLockerState,
} from './support/kioskTestBridge.js';

async function tapDiagnosticZone(page) {
  const viewport = page.viewportSize();
  await page.evaluate(({ x, y }) => {
    for (let tap = 0; tap < 7; tap += 1) {
      document.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: x,
        clientY: y,
      }));
    }
  }, { x: viewport.width - 10, y: 10 });
}

async function revealDiagnostics(page) {
  await tapDiagnosticZone(page);
  await expect(page.getByRole('dialog', { name: 'Console tecnico' })).toBeVisible();
}

async function expectConsoleInsideViewport(page) {
  const geometry = await page.getByRole('dialog', { name: 'Console tecnico' }).evaluate((dialog) => {
    const rect = dialog.getBoundingClientRect();
    const visibleControls = [...dialog.querySelectorAll('button, input, select')].filter((element) => {
      const style = window.getComputedStyle(element);
      const elementRect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && elementRect.width > 0 && elementRect.height > 0;
    });
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentOverflowX: document.documentElement.scrollWidth - window.innerWidth,
      clippedControls: visibleControls.filter((element) => {
        const controlRect = element.getBoundingClientRect();
        const scrollContainer = element.closest('.diagnostic-content, .diagnostic-mode-tabs');
        const clippedX = controlRect.left < -1 || controlRect.right > window.innerWidth + 1;
        const clippedY = controlRect.top < -1 || controlRect.bottom > window.innerHeight + 1;
        return !scrollContainer && (clippedX || clippedY);
      }).map((element) => element.getAttribute('aria-label') || element.textContent.trim()),
    };
  });
  expect(geometry).toEqual({
    left: 0,
    top: 0,
    right: geometry.viewportWidth,
    bottom: geometry.viewportHeight,
    viewportWidth: geometry.viewportWidth,
    viewportHeight: geometry.viewportHeight,
    documentOverflowX: 0,
    clippedControls: [],
  });
}

test('parametro de URL nao libera o console tecnico', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.dismiss());
  await bootKiosk(page, { url: '/?diagnostics=1' });
  await expect(page.getByRole('dialog', { name: 'Console tecnico' })).toHaveCount(0);
  await tapDiagnosticZone(page);
  await expect(page.getByRole('dialog', { name: 'Console tecnico' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Entregar encomenda/i })).toBeVisible();
  const state = await readLockerState(page);
  expect(state.auditTrail).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'diagnostic-access', meta: expect.objectContaining({ outcome: 'blocked' }) }),
  ]));
});

test('PIN tecnico invalido mantem o console bloqueado', async ({ page }) => {
  await bootKiosk(page, { diagnostics: true });
  await page.evaluate(() => { window.__predditaPromptValue = '00000000'; });
  await tapDiagnosticZone(page);
  await expect(page.getByRole('dialog', { name: 'Console tecnico' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__predditaAlerts)).toContain('Credencial tecnica invalida.');
  const state = await readLockerState(page);
  expect(state.auditTrail).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'diagnostic-access', meta: expect.objectContaining({ outcome: 'auth-failed' }) }),
  ]));
});

test('console autenticado organiza diagnostico e limita ajustes', async ({ page }) => {
  const browserErrors = await bootKiosk(page, { diagnostics: true });
  await revealDiagnostics(page);

  const consoleDialog = page.getByRole('dialog', { name: 'Console tecnico' });
  await expect(consoleDialog.getByRole('heading', { name: 'Diagnostico de campo' })).toBeVisible();
  await expect(consoleDialog.getByRole('tab')).toHaveCount(6);
  await expectConsoleInsideViewport(page);

  await consoleDialog.getByRole('tab', { name: 'Conectividade' }).click();
  await expect(consoleDialog.getByText('/dev/e2e-rs485')).toBeVisible();
  await consoleDialog.getByRole('button', { name: /Reconectar serial/ }).click();

  await page.evaluate(() => {
    window.__predditaCameraTrack = {
      stopped: false,
      stop() { this.stopped = true; },
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [window.__predditaCameraTrack] }) },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      configurable: true,
      get() { return this.__predditaStream || null; },
      set(value) { this.__predditaStream = value; },
    });
    HTMLMediaElement.prototype.play = () => Promise.resolve();
  });
  await consoleDialog.getByRole('tab', { name: 'Camera' }).click();
  await consoleDialog.getByRole('button', { name: 'Iniciar preview' }).click();
  await expect(consoleDialog.getByText('Preview local ativo. Nenhuma imagem e salva.')).toBeVisible();

  await consoleDialog.getByRole('tab', { name: 'Tela' }).click();
  await expect.poll(() => page.evaluate(() => window.__predditaCameraTrack.stopped)).toBe(true);
  const brightness = consoleDialog.getByRole('slider', { name: 'Brilho' });
  const volume = consoleDialog.getByRole('slider', { name: 'Volume de midia' });
  await brightness.fill('85');
  await brightness.dispatchEvent('pointerup');
  await volume.fill('60');
  await volume.dispatchEvent('pointerup');
  await consoleDialog.getByRole('switch', { name: 'Manter tela ligada' }).uncheck();

  const nativeEvents = await page.evaluate(() => window.__predditaDiagnosticEvents);
  expect(nativeEvents).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'verify-pin', accepted: true }),
    expect.objectContaining({ type: 'retry-serial', accepted: true }),
    expect.objectContaining({ type: 'brightness', value: 85, accepted: true }),
    expect.objectContaining({ type: 'volume', value: 60, accepted: true }),
    expect.objectContaining({ type: 'keep-screen-on', value: false, accepted: true }),
  ]));

  await consoleDialog.getByRole('button', { name: 'Fechar console tecnico' }).click();
  await expect(consoleDialog).toHaveCount(0);
  const state = await readLockerState(page);
  expect(state.auditTrail).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'diagnostic-access', meta: expect.objectContaining({ actor: 'technical-local', lockerId: expect.any(String), outcome: 'opened' }) }),
    expect.objectContaining({ kind: 'diagnostic-display', meta: expect.objectContaining({ actor: 'technical-local' }) }),
    expect.objectContaining({ kind: 'diagnostic-serial', meta: expect.objectContaining({ actor: 'technical-local' }) }),
  ]));
  expect(browserErrors).toEqual([]);
});

test('teste de porta exige confirmacao e registra prova', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'kiosk-1024x600', 'O ciclo fisico completo roda no viewport de referencia.');
  const browserErrors = await bootKiosk(page, { diagnostics: true });
  await revealDiagnostics(page);
  const consoleDialog = page.getByRole('dialog', { name: 'Console tecnico' });
  await consoleDialog.getByRole('tab', { name: 'Portas' }).click();

  await consoleDialog.getByRole('button', { name: 'Identificar e testar' }).first().click();
  const confirmation = page.getByRole('alertdialog', { name: 'Testar porta 1?' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole('button', { name: 'Cancelar' })).toBeFocused();
  await confirmation.getByRole('button', { name: 'Confirmar e testar' }).click();
  await expect(consoleDialog.getByText('Porta 1: identificada. Feche a porta para concluir.')).toBeVisible();
  await closeTestDoor(page, 1);
  await expect(consoleDialog.getByText('Porta 1 mapeada e sensor validado.')).toBeVisible();

  const state = await readLockerState(page);
  expect(state.auditTrail).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'diagnostic-door-test',
      meta: expect.objectContaining({ actor: 'technical-local', channel: 1, outcome: 'passed', closeProof: true }),
    }),
  ]));
  expect(browserErrors).toEqual([]);
});

test('sessao tecnica expira e retorna ao inicio', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'kiosk-1024x600', 'O relogio de sessao roda no viewport de referencia.');
  await page.clock.install();
  await bootKiosk(page, { diagnostics: true });
  await revealDiagnostics(page);
  await page.clock.runFor(5 * 60 * 1000 + 10);

  await expect(page.getByRole('dialog', { name: 'Console tecnico' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Entregar encomenda/i })).toBeVisible();
  const state = await readLockerState(page);
  expect(state.auditTrail).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'diagnostic-access', meta: expect.objectContaining({ outcome: 'timeout' }) }),
  ]));
});
