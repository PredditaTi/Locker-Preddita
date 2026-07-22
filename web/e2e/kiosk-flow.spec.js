import { expect, test } from '@playwright/test';
import QRCode from 'qrcode';
import {
  LOCKER_STORAGE_KEY,
  bootKiosk,
  closeTestDoor,
  getTestOpenCommands,
  getTestDoorState,
  installPackageAnalyzerBridge,
  installStablePackageCamera,
  readLockerState,
  startManualDelivery,
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

async function readSmartDeliveryTelemetry(page) {
  return page.evaluate(() => JSON.parse(
    window.localStorage.getItem('preddita_smart_delivery_telemetry_v1') || '{"events":[]}',
  ));
}

test('entregador deposita e morador retira a mesma encomenda', async ({ page }) => {
  const browserErrors = await bootKiosk(page);

  await expect(page.getByRole('button', { name: /Entregar encomenda/i })).toBeVisible();
  await page.getByRole('button', { name: /Entregar encomenda/i }).click();
  await expect(page.getByRole('heading', { name: 'Como deseja entregar?' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Entrega Inteligente/i })).toBeEnabled();
  await page.getByRole('button', { name: /Entrega Manual/i }).click();
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

test('entrega inteligente captura pacote estavel sem reservar ou abrir porta', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'kiosk-1024x600',
    'O contrato da captura automatica roda uma vez; a matriz de layout cobre os demais viewports.'
  );
  const browserErrors = await bootKiosk(page);
  await installStablePackageCamera(page);
  await installPackageAnalyzerBridge(page);
  const stateBeforeCapture = await readLockerState(page);

  await page.getByRole('button', { name: /Entregar encomenda/i }).click();
  await page.getByRole('button', { name: /Entrega Inteligente/i }).click();
  await page.getByRole('textbox', { name: 'Apartamento', exact: true }).fill('203');
  await page.getByRole('button', { name: 'Apartamento 203', exact: true }).click();
  await expect(page.getByText('Nenhuma porta sera aberta.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continuar para camera', exact: true })).toBeVisible();
  expect(await getTestOpenCommands(page)).toEqual([]);

  await page.getByRole('button', { name: 'Continuar para camera', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mostre o pacote', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar camera', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Analise inconclusiva', exact: true })).toBeVisible({ timeout: 8000 });
  await expect(page.getByText('O modelo P/G ainda nao esta instalado.')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Pacote fotografado' })).toBeVisible();
  const cameraProbe = await page.evaluate(() => window.__predditaPackageCamera);
  expect(cameraProbe.getUserMediaCalls).toBe(1);
  expect(cameraProbe.trackStopped).toBe(true);
  const analyzerRequests = await page.evaluate(() => window.__predditaPackageAnalyzerRequests);
  expect(analyzerRequests).toHaveLength(1);
  expect(analyzerRequests[0].photoDataUrl).toMatch(/^data:image\/jpeg;base64,/);
  expect(analyzerRequests[0]).not.toHaveProperty('channel');
  expect(analyzerRequests[0]).not.toHaveProperty('board');

  const stateAfterCapture = await readLockerState(page);
  expect(stateAfterCapture.deliveries).toEqual(stateBeforeCapture.deliveries);
  expect(await getTestOpenCommands(page)).toEqual([]);
  for (let channel = 1; channel <= 10; channel += 1) {
    expect(await getTestDoorState(page, channel)).toBe('closed');
  }

  await page.getByRole('button', { name: 'Usar entrega manual', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Abrir porta', exact: true })).toBeVisible();
  const telemetry = await readSmartDeliveryTelemetry(page);
  expect(telemetry.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'analysis', outcome: 'uncertain', reasonCode: 'model-not-installed' }),
    expect.objectContaining({ action: 'recommendation', outcome: 'manual-fallback', reasonCode: 'user-selected-manual' }),
  ]));
  expect(JSON.stringify(telemetry)).not.toContain('data:image');
  expect(telemetry.events.every((event) => !('apartment' in event) && !('door' in event))).toBe(true);
  expect(browserErrors).toEqual([]);
});

for (const scenario of [
  { size: 'P', doorSize: 'P', reviewLabel: 'Pequena (P)', action: 'Abrir porta pequena' },
  { size: 'G', doorSize: 'G', reviewLabel: 'Grande (G)', action: 'Abrir porta grande' },
]) {
  test(`entrega inteligente ${scenario.size} exige revisao e abre somente porta ${scenario.doorSize}`, async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'kiosk-1024x600',
      'A integracao de decisao e hardware simulado roda uma vez; o layout cobre os demais viewports.'
    );
    const browserErrors = await bootKiosk(page);
    await installStablePackageCamera(page);
    await installPackageAnalyzerBridge(page, {
      status: 'ready',
      suggestedSize: scenario.size,
      confidence: 0.97,
      reasonCode: '',
    });
    const stateBeforeCapture = await readLockerState(page);

    await page.getByRole('button', { name: /Entregar encomenda/i }).click();
    await page.getByRole('button', { name: /Entrega Inteligente/i }).click();
    await page.getByRole('textbox', { name: 'Apartamento', exact: true }).fill('203');
    await page.getByRole('button', { name: 'Apartamento 203', exact: true }).click();
    await page.getByRole('button', { name: 'Continuar para camera', exact: true }).click();
    await page.getByRole('button', { name: 'Iniciar camera', exact: true }).click();

    await expect(page.getByRole('heading', { name: `Pacote identificado: tamanho ${scenario.size}` }))
      .toBeVisible({ timeout: 8000 });
    await expect(page.getByRole('button', { name: 'Revisar recomendacao', exact: true })).toBeVisible();
    expect(await getTestOpenCommands(page)).toEqual([]);
    expect((await readLockerState(page)).deliveries).toEqual(stateBeforeCapture.deliveries);

    await page.getByRole('button', { name: 'Revisar recomendacao', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Revise a recomendacao', exact: true })).toBeVisible();
    await expect(page.locator('.public-kiosk-screen--smart-review .public-confirm-card strong'))
      .toHaveText(scenario.reviewLabel);
    expect(await getTestOpenCommands(page)).toEqual([]);
    expect((await readLockerState(page)).deliveries).toEqual(stateBeforeCapture.deliveries);

    await page.getByRole('button', { name: scenario.action, exact: true }).click();
    const doorHero = page.locator('.public-door-hero strong');
    await expect(doorHero).toContainText(/^Porta \d+$/);
    const door = Number((await doorHero.textContent()).match(/\d+/)?.[0]);
    const openedState = await readLockerState(page);
    const delivery = openedState.deliveries.find((item) => item.status === 'door_opened_for_dropoff');

    expect(delivery).toBeTruthy();
    expect(delivery.size).toBe(scenario.size);
    expect(delivery.doorSize).toBe(scenario.doorSize);
    expect(delivery.door).toBe(door);
    expect(delivery.labelPhotoDataUrl).toBe('');
    expect(delivery.labelPhotoCapturedAt).toBe('');
    expect(await getTestOpenCommands(page)).toEqual([door]);

    const storedButton = page.getByRole('button', { name: 'Item guardado', exact: true });
    await expect(storedButton).toBeEnabled();
    await closeTestDoor(page, door);
    await storedButton.click();
    await expect(page.getByRole('heading', { name: 'Pronto', exact: true })).toBeVisible();
    const storedState = await readLockerState(page);
    const storedDelivery = storedState.deliveries.find((item) => item.status === 'stored');
    expect(storedDelivery.labelPhotoDataUrl).toBe('');
    expect(storedDelivery.labelPhotoCapturedAt).toBe('');
    const telemetry = await readSmartDeliveryTelemetry(page);
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'analysis', outcome: 'ready', size: scenario.size }),
      expect.objectContaining({ action: 'recommendation', outcome: 'confirmed', size: scenario.size }),
      expect.objectContaining({ action: 'allocation', outcome: 'opened', size: scenario.size }),
    ]));
    expect(JSON.stringify(telemetry)).not.toContain('data:image');
    expect(telemetry.events.every((event) => !('apartment' in event) && !('door' in event))).toBe(true);
    expect(browserErrors).toEqual([]);
  });
}

test('entrega inteligente P nao usa porta G quando todas as pequenas estao indisponiveis', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'kiosk-1024x600',
    'A falha segura de alocacao roda uma vez no viewport de referencia.'
  );
  const browserErrors = await bootKiosk(page);
  await installStablePackageCamera(page);
  await installPackageAnalyzerBridge(page, {
    status: 'ready',
    suggestedSize: 'P',
    confidence: 0.98,
    reasonCode: '',
  });
  const stateBeforeCapture = await readLockerState(page);

  await page.getByRole('button', { name: /Entregar encomenda/i }).click();
  await page.getByRole('button', { name: /Entrega Inteligente/i }).click();
  await page.getByRole('textbox', { name: 'Apartamento', exact: true }).fill('203');
  await page.getByRole('button', { name: 'Apartamento 203', exact: true }).click();
  await page.getByRole('button', { name: 'Continuar para camera', exact: true }).click();
  await page.getByRole('button', { name: 'Iniciar camera', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revisar recomendacao', exact: true }))
    .toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: 'Revisar recomendacao', exact: true }).click();

  await page.evaluate(() => {
    for (let channel = 3; channel <= 24; channel += 1) {
      window.__predditaTestHardware.setDoorState(channel, 'open');
    }
  });
  await page.getByRole('button', { name: 'Abrir porta pequena', exact: true }).click();

  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('heading', { name: 'Porta recomendada indisponivel' })).toBeVisible();
  await expect(dialog.getByText('Nenhuma porta pequena livre confirmou fechamento pelo sensor.')).toBeVisible();
  expect(await getTestOpenCommands(page)).toEqual([]);
  expect((await readLockerState(page)).deliveries).toEqual(stateBeforeCapture.deliveries);
  const telemetry = await readSmartDeliveryTelemetry(page);
  expect(telemetry.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'allocation', outcome: 'unavailable', size: 'P', reasonCode: 'door-unavailable' }),
  ]));
  expect(browserErrors).toEqual([]);
});

test('morador retira por QR e as credenciais sao apagadas', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'kiosk-1024x600',
    'A matriz de layout cobre os outros viewports; o contrato da camera roda uma vez.'
  );
  const browserErrors = await bootKiosk(page);

  await startManualDelivery(page);
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
