import { expect, test } from '@playwright/test';
import { bootKiosk } from './support/kioskTestBridge.js';

async function expectStableViewport(page) {
  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
    controls: [...document.querySelectorAll('button:not([hidden])')].map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        name: button.getAttribute('aria-label') || button.textContent.trim(),
        width: rect.width,
        height: rect.height,
      };
    }),
  }));

  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
  for (const control of layout.controls) {
    expect(control.width, `${control.name}: largura do alvo`).toBeGreaterThanOrEqual(64);
    expect(control.height, `${control.name}: altura do alvo`).toBeGreaterThanOrEqual(64);
  }
}

test('prototipo V4 navega pelos cinco estados sem integrar com o Edge Agent', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'kiosk-1024x600',
    'As referencias de produto desta etapa usam o viewport fisico de 1024x600.'
  );

  const browserErrors = await bootKiosk(page, { url: '/?kioskPrototype=home' });
  await expect(page.getByRole('button', { name: /Entregar encomenda/i })).toBeVisible();
  await expectStableViewport(page);

  await page.getByRole('button', { name: /Entregar encomenda/i }).click();
  await expect(page.getByRole('heading', { name: 'Qual e o apartamento?' })).toBeVisible();
  await expectStableViewport(page);

  await page.getByRole('button', { name: 'Apartamento 203', exact: true }).click();
  await expect(page.getByRole('heading', { name: '3', exact: true })).toBeVisible();
  await expectStableViewport(page);

  await page.getByRole('button', { name: 'Item guardado', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pronto', exact: true })).toBeVisible();
  await expectStableViewport(page);

  await page.getByRole('button', { name: 'Inicio', exact: true }).click();
  await page.getByRole('button', { name: /Retirar encomenda/i }).click();
  await expect(page.getByRole('heading', { name: 'Digite seu PIN', exact: true })).toBeVisible();
  await expectStableViewport(page);

  for (const digit of '123456') {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await expect(page.getByLabel('PIN informado')).toContainText('••••••');
  expect(browserErrors).toEqual([]);
});
