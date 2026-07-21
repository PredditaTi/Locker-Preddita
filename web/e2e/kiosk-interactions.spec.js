import { expect, test } from '@playwright/test';
import {
  bootKiosk,
  closeTestDoor,
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
  const doorText = await page.locator('.public-door-hero strong').textContent();
  return Number(doorText?.match(/\d+/)?.[0]);
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

test('cancelamento aguarda a porta fechar antes de limpar a reserva', async ({ page }, testInfo) => {
  onlyReferenceKiosk(testInfo);
  const browserErrors = await bootKiosk(page);
  const depositDoor = await openSmallDepositDoor(page);

  await page.getByRole('button', { name: 'Nao coube', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancelar', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();

  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('heading', { name: 'Feche a porta para cancelar' })).toBeVisible();
  const activeState = await readLockerState(page);
  expect(activeState.deliveries?.find((delivery) => delivery.status === 'door_opened_for_dropoff')).toBeTruthy();
  await dialog.getByRole('button', { name: 'Entendi', exact: true }).click();

  await closeTestDoor(page, depositDoor);
  await expect(dialog.getByRole('heading', { name: 'Operacao cancelada' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Entendi', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Qual e o apartamento?' })).toBeVisible();

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

test('porta grande so abre depois da prova de fechamento da porta pequena', async ({ page }, testInfo) => {
  onlyReferenceKiosk(testInfo);
  const browserErrors = await bootKiosk(page);
  const smallDoor = await openSmallDepositDoor(page);

  await page.getByRole('button', { name: 'Nao coube', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancelar', exact: true })).toBeVisible();
  await closeTestDoor(page, smallDoor);

  const largeDoorHero = page.locator('.public-door-hero strong');
  await expect(page.locator('.public-door-hero span')).toHaveText('Porta grande aberta');
  await expect(largeDoorHero).not.toHaveText(`Porta ${smallDoor}`);
  const largeDoor = Number((await largeDoorHero.textContent()).match(/\d+/)?.[0]);
  expect([1, 2]).toContain(largeDoor);
  expect(largeDoor).not.toBe(smallDoor);

  const stateAfterFallback = await readLockerState(page);
  const cancelledSmall = stateAfterFallback.deliveries?.find(
    (delivery) => delivery.door === smallDoor && delivery.status === 'cancelled'
  );
  const activeLarge = stateAfterFallback.deliveries?.find(
    (delivery) => delivery.door === largeDoor && delivery.status === 'door_opened_for_dropoff'
  );
  expect(cancelledSmall).toBeTruthy();
  expect(cancelledSmall.pin).toBe('');
  expect(cancelledSmall.token).toBe('');
  expect(cancelledSmall.qrPayload).toBe('');
  expect(activeLarge).toBeTruthy();

  const storedButton = page.getByRole('button', { name: 'Item guardado', exact: true });
  await expect(storedButton).toBeEnabled();
  await closeTestDoor(page, largeDoor);
  await storedButton.click();
  await expect(page.getByRole('heading', { name: 'Pronto', exact: true })).toBeVisible();

  const finalState = await readLockerState(page);
  const storedLarge = finalState.deliveries?.find((delivery) => delivery.id === activeLarge.id);
  expect(storedLarge.status).toBe('stored');
  expect(storedLarge.dropoffCloseProof?.channel).toBe(largeDoor);
  expect(browserErrors).toEqual([]);
});
