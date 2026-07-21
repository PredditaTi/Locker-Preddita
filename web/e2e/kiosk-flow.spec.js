import { expect, test } from '@playwright/test';
import QRCode from 'qrcode';
import {
  LOCKER_STORAGE_KEY,
  bootKiosk,
  closeTestDoor,
  getTestDoorState,
  readLockerState,
} from './support/kioskTestBridge.js';

function createQrFrame(payload, scale = 5, margin = 4) {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const moduleCount = qr.modules.size;
  const size = (moduleCount + (margin * 2)) * scale;
  const pixels = new Uint8ClampedArray(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const moduleX = Math.floor(x / scale) - margin;
      const moduleY = Math.floor(y / scale) - margin;
      const isDark = moduleX >= 0
        && moduleY >= 0
        && moduleX < moduleCount
        && moduleY < moduleCount
        && qr.modules.get(moduleY, moduleX);
      const offset = (y * size + x) * 4;
      const color = isDark ? 0 : 255;
      pixels[offset] = color;
      pixels[offset + 1] = color;
      pixels[offset + 2] = color;
      pixels[offset + 3] = 255;
    }
  }

  return { width: size, height: size, pixels: [...pixels] };
}

async function installQrCamera(page, payload) {
  const frame = createQrFrame(payload);
  await page.evaluate((qrFrame) => {
    const stream = new MediaStream();
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => stream },
    });
    Object.defineProperties(window.HTMLMediaElement.prototype, {
      readyState: { configurable: true, get: () => 4 },
    });
    Object.defineProperties(window.HTMLVideoElement.prototype, {
      videoWidth: { configurable: true, get: () => qrFrame.width },
      videoHeight: { configurable: true, get: () => qrFrame.height },
    });
    window.HTMLMediaElement.prototype.play = async () => {};
    window.CanvasRenderingContext2D.prototype.drawImage = () => {};
    window.CanvasRenderingContext2D.prototype.getImageData = () => new ImageData(
      new Uint8ClampedArray(qrFrame.pixels),
      qrFrame.width,
      qrFrame.height
    );
  }, frame);
}

test('entregador deposita e morador retira a mesma encomenda', async ({ page }) => {
  const browserErrors = await bootKiosk(page);

  await expect(page.getByRole('button', { name: /Entregar encomenda/i })).toBeVisible();
  await page.getByRole('button', { name: /Entregar encomenda/i }).click();
  await expect(page.getByRole('heading', { name: 'Qual e o apartamento?' })).toBeVisible();

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
  await expect(page.getByRole('heading', { name: 'Pronto', exact: true })).toBeVisible();

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
  await expect(page.getByRole('heading', { name: 'Retirada concluida', exact: true })).toBeVisible();

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

test('morador retira por QR e as credenciais sao apagadas', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'kiosk-1024x600',
    'A matriz de layout cobre os outros viewports; o contrato da camera roda uma vez.'
  );
  const browserErrors = await bootKiosk(page);

  await page.getByRole('button', { name: /Entregar encomenda/i }).click();
  await page.getByRole('textbox', { name: 'Apartamento', exact: true }).fill('203');
  await page.getByRole('button', { name: 'Apartamento 203', exact: true }).click();
  await page.getByRole('button', { name: 'Abrir porta', exact: true }).click();

  const doorHero = page.locator('.public-door-hero strong');
  await expect(doorHero).toContainText(/^Porta \d+$/);
  const door = Number((await doorHero.textContent()).match(/\d+/)?.[0]);
  const storedButton = page.getByRole('button', { name: 'Item guardado', exact: true });
  await expect(storedButton).toBeEnabled();
  await closeTestDoor(page, door);
  await storedButton.click();
  await expect(page.getByRole('heading', { name: 'Pronto', exact: true })).toBeVisible();

  const storedState = await readLockerState(page);
  const storedDelivery = storedState.deliveries?.find((delivery) => delivery.status === 'stored');
  expect(storedDelivery.qrPayload).toMatch(/^preddita:\/\/collect\?/);
  await installQrCamera(page, storedDelivery.qrPayload);

  await page.getByRole('button', { name: 'Inicio', exact: true }).click();
  await page.getByRole('button', { name: /Retirar encomenda/i }).click();
  await page.getByRole('tab', { name: 'QR', exact: true }).click();
  await page.getByRole('button', { name: 'Abrir camera', exact: true }).click();

  await expect(page.locator('.public-kiosk-screen--pickup-open .public-door-hero strong'))
    .toHaveText(`Porta ${door}`);
  expect(await getTestDoorState(page, door)).toBe('open');

  await closeTestDoor(page, door);
  await page.getByRole('button', { name: 'Ja fechei a porta', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Retirada concluida', exact: true })).toBeVisible();

  const finalState = await readLockerState(page);
  const collected = finalState.deliveries?.find((delivery) => delivery.id === storedDelivery.id);
  expect(collected.status).toBe('collected');
  expect(collected.pickupCloseProof?.channel).toBe(door);
  expect(collected.pin).toBe('');
  expect(collected.token).toBe('');
  expect(collected.qrPayload).toBe('');
  expect(collected.credentialsErasedAt).toBeTruthy();
  expect(browserErrors).toEqual([]);
});
