import { expect, test } from '@playwright/test';
import {
  bootKiosk,
  readLockerState,
} from './support/kioskTestBridge.js';

function onlyReferenceKiosk(testInfo) {
  test.skip(
    testInfo.project.name !== 'kiosk-1024x600',
    'Contratos de interacao rodam uma vez; a matriz visual cobre os demais viewports.'
  );
}

async function openSmallDepositDoor(page) {
  await page.getByRole('button', { name: /Entregar encomenda/i }).click();
  await page.getByRole('textbox', { name: 'Apartamento', exact: true }).fill('203');
  await page.getByRole('button', { name: 'Apartamento 203', exact: true }).click();
  await page.getByRole('button', { name: 'Abrir porta', exact: true }).click();
  await expect(page.locator('.public-door-hero strong')).toContainText(/^Porta \d+$/);
}

test('teclado numerico permite apagar e retornar ao inicio', async ({ page }, testInfo) => {
  onlyReferenceKiosk(testInfo);
  const browserErrors = await bootKiosk(page);

  await page.getByRole('button', { name: /Entregar encomenda/i }).click();
  const pad = page.locator('.public-apartment-input .public-number-pad');
  for (const key of ['2', '0', '4', 'Apagar', '3']) {
    await pad.getByRole('button', { name: key, exact: true }).click();
  }

  await expect(page.getByRole('textbox', { name: 'Apartamento', exact: true })).toHaveValue('203');
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();
  await expect(page.getByRole('button', { name: /Entregar encomenda/i })).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test('cancelamento limpa a reserva e retorna para uma nova entrega', async ({ page }, testInfo) => {
  onlyReferenceKiosk(testInfo);
  const browserErrors = await bootKiosk(page);
  await openSmallDepositDoor(page);

  await page.getByRole('button', { name: 'Nao coube', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancelar', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();

  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('heading', { name: 'Operacao cancelada' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Entendi', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Digite o apartamento' })).toBeVisible();

  const state = await readLockerState(page);
  const cancelled = state.deliveries?.find((delivery) => delivery.status === 'cancelled');
  expect(cancelled).toBeTruthy();
  expect(cancelled.pin).toBe('');
  expect(cancelled.token).toBe('');
  expect(cancelled.qrPayload).toBe('');
  expect(browserErrors).toEqual([]);
});

test('timeout de fechamento mantem a reserva e orienta o entregador', async ({ page }, testInfo) => {
  onlyReferenceKiosk(testInfo);
  await page.clock.install();
  const browserErrors = await bootKiosk(page);
  await openSmallDepositDoor(page);

  await page.getByRole('button', { name: 'Nao coube', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancelar', exact: true })).toBeVisible();
  await page.clock.runFor(61_000);

  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('heading', { name: 'Porta pequena ainda aberta' })).toBeVisible();
  await expect(dialog).toContainText('Feche a porta');

  const state = await readLockerState(page);
  const active = state.deliveries?.find((delivery) => delivery.status === 'door_opened_for_dropoff');
  expect(active).toBeTruthy();
  expect(browserErrors).toEqual([]);
});
