import { expect, test } from '@playwright/test';
import {
  LOCKER_STORAGE_KEY,
  bootKiosk,
  closeTestDoor,
  getTestDoorState,
  readLockerState,
} from './support/kioskTestBridge.js';

test('entregador deposita e morador retira a mesma encomenda', async ({ page }) => {
  const browserErrors = await bootKiosk(page);

  await expect(page.getByRole('button', { name: /Entregar encomenda/i })).toBeVisible();
  await page.getByRole('button', { name: /Entregar encomenda/i }).click();
  await expect(page.getByRole('heading', { name: 'Digite o apartamento' })).toBeVisible();

  await page.getByRole('textbox', { name: 'Apartamento', exact: true }).fill('203');
  await page.getByRole('button', { name: 'Apartamento 203', exact: true }).click();
  await expect(page.locator('.public-confirm-card strong')).toContainText('203');
  await expect(page.getByRole('button', { name: 'Abrir porta', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Abrir porta', exact: true }).click();

  const openDoorHero = page.locator('.public-door-hero strong');
  await expect(openDoorHero).toContainText(/^Porta \d+$/);
  const depositDoor = Number((await openDoorHero.textContent()).match(/\d+/)?.[0]);
  expect(depositDoor).toBeGreaterThan(0);
  expect(await getTestDoorState(page, depositDoor)).toBe('open');

  const storedButton = page.getByRole('button', { name: 'Item guardado' });
  await expect(storedButton).toBeEnabled();
  await closeTestDoor(page, depositDoor);
  await storedButton.click();
  await expect(page.getByRole('heading', { name: /Entrega salva|Entrega registrada/i })).toBeVisible();

  const storedState = await readLockerState(page);
  const storedDelivery = storedState.deliveries?.find((delivery) => delivery.status === 'stored') || null;
  expect(storedDelivery).toBeTruthy();
  expect(storedDelivery.pin).toMatch(/^\d{6}$/);
  expect(storedDelivery.door).toBe(depositDoor);
  expect(storedDelivery.dropoffCloseProof?.channel).toBe(depositDoor);

  await page.getByRole('button', { name: 'Inicio', exact: true }).click();
  await page.getByRole('button', { name: /Retirar encomenda/i }).click();
  await expect(page.getByRole('heading', { name: 'Digite seu PIN' })).toBeVisible();

  for (const digit of storedDelivery.pin) {
    await page.locator('.public-number-pad--pin').getByRole('button', { name: digit, exact: true }).click();
  }

  await expect(page.locator('.public-kiosk-screen--pickup-open .public-door-hero strong'))
    .toHaveText(`Porta ${depositDoor}`);
  expect(await getTestDoorState(page, depositDoor)).toBe('open');

  const pickupCompleteButton = page.getByRole('button', { name: 'Ja fechei a porta' });
  await expect(pickupCompleteButton).toBeEnabled();
  await closeTestDoor(page, depositDoor);
  await pickupCompleteButton.click();
  await expect(page.getByText('Retirada concluida', { exact: true })).toBeVisible();

  const collectedDelivery = await page.evaluate(({ storageKey, deliveryId }) => {
    const state = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
    return state.deliveries?.find((delivery) => delivery.id === deliveryId) || null;
  }, { storageKey: LOCKER_STORAGE_KEY, deliveryId: storedDelivery.id });
  expect(collectedDelivery.status).toBe('collected');
  expect(collectedDelivery.pickupCloseProof?.channel).toBe(depositDoor);
  expect(collectedDelivery.collectedAt).toBeTruthy();
  expect(collectedDelivery.pin).toBe('');
  expect(collectedDelivery.token).toBe('');
  expect(collectedDelivery.qrPayload).toBe('');
  expect(collectedDelivery.credentialsErasedAt).toBeTruthy();

  await page.reload();
  await expect(page.getByRole('button', { name: /Entregar encomenda/i })).toBeVisible();
  const persistedDelivery = await page.evaluate(({ storageKey, deliveryId }) => {
    const state = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
    return state.deliveries?.find((delivery) => delivery.id === deliveryId) || null;
  }, { storageKey: LOCKER_STORAGE_KEY, deliveryId: storedDelivery.id });
  expect(persistedDelivery.status).toBe('collected');
  expect(persistedDelivery.pin).toBe('');
  expect(persistedDelivery.token).toBe('');
  expect(persistedDelivery.qrPayload).toBe('');
  expect(persistedDelivery.credentialsErasedAt).toBeTruthy();
  expect(browserErrors).toEqual([]);
});
