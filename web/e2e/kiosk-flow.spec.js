import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'preddita_entregas_locker_state_v1';

function installRs485Bridge() {
  const doorStates = Array.from({ length: 24 }, () => 'closed');
  const bcc = (bytes) => bytes.reduce((value, byte) => value ^ (byte & 0xff), 0) & 0xff;
  const toHex = (bytes) => bytes
    .map((byte) => (byte & 0xff).toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
  const frame = (payload) => toHex([...payload, bcc(payload)]);
  const packedStates = () => {
    const bytes = new Array(3).fill(0);
    doorStates.forEach((state, index) => {
      if (state !== 'open') {
        const byteIndex = bytes.length - 1 - Math.floor(index / 8);
        bytes[byteIndex] |= 1 << (index % 8);
      }
    });
    return bytes;
  };

  window.__predditaTestHardware = {
    closeDoor(channel) {
      doorStates[channel - 1] = 'closed';
    },
    getDoorState(channel) {
      return doorStates[channel - 1];
    },
  };

  window.Android = {
    sendRS485(hexString) {
      const [command, board, channel, parameter] = String(hexString)
        .trim()
        .split(/\s+/)
        .map((part) => Number.parseInt(part, 16));
      let response;

      if (command === 0x80 && channel === 0) {
        response = frame([0x80, board, ...packedStates(), 0x33]);
      } else if (command === 0x80) {
        response = frame([0x80, board, channel, doorStates[channel - 1] === 'open' ? 0x00 : 0x11]);
      } else if ([0x8a, 0x7a, 0x7c, 0x7f, 0x9a].includes(command)) {
        doorStates[channel - 1] = 'open';
        response = command === 0x8a || command === 0x9a
          ? frame([command, board, channel, 0x00])
          : frame([command, board, channel, parameter]);
      } else if (command === 0x9b) {
        doorStates[channel - 1] = 'closed';
        response = frame([0x9b, board, channel, 0x11]);
      } else if (command === 0x9d) {
        doorStates.fill('open');
        response = frame([0x9e, board, ...packedStates()]);
      } else {
        response = frame([command, board, channel, parameter]);
      }

      window.setTimeout(() => window.onRS485Response(response), 5);
    },
    getBridgeVersion() {
      return 'E2E-RS485-BRIDGE';
    },
    isSerialOpen() {
      return true;
    },
    getSerialPath() {
      return '/dev/e2e-rs485';
    },
    getLastSerialError() {
      return '';
    },
  };
}

test('entregador deposita e morador retira a mesma encomenda', async ({ page }) => {
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.addInitScript(installRs485Bridge);
  await page.goto('/');

  await expect(page.getByRole('button', { name: /Entregar encomenda/i })).toBeVisible();
  await page.getByRole('button', { name: /Entregar encomenda/i }).click();
  await expect(page.getByRole('heading', { name: 'Digite o apartamento' })).toBeVisible();

  await page.getByRole('textbox', { name: 'Apartamento', exact: true }).fill('203');
  await page.getByRole('button', { name: 'Apartamento 203', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Apartamento correto?' })).toBeVisible();
  await page.getByRole('button', { name: 'Abrir porta', exact: true }).click();

  const openDoorHero = page.locator('.public-door-hero strong');
  await expect(openDoorHero).toContainText(/^Porta \d+$/);
  const depositDoor = Number((await openDoorHero.textContent()).match(/\d+/)?.[0]);
  expect(depositDoor).toBeGreaterThan(0);
  expect(await page.evaluate((door) => window.__predditaTestHardware.getDoorState(door), depositDoor)).toBe('open');

  const storedButton = page.getByRole('button', { name: 'Item guardado' });
  await expect(storedButton).toBeEnabled();
  await page.evaluate((door) => window.__predditaTestHardware.closeDoor(door), depositDoor);
  await storedButton.click();
  await expect(page.getByRole('heading', { name: /Entrega salva|Entrega registrada/i })).toBeVisible();

  const storedDelivery = await page.evaluate((storageKey) => {
    const state = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
    return state.deliveries?.find((delivery) => delivery.status === 'stored') || null;
  }, STORAGE_KEY);
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
  expect(await page.evaluate((door) => window.__predditaTestHardware.getDoorState(door), depositDoor)).toBe('open');

  const pickupCompleteButton = page.getByRole('button', { name: 'Ja fechei a porta' });
  await expect(pickupCompleteButton).toBeEnabled();
  await page.evaluate((door) => window.__predditaTestHardware.closeDoor(door), depositDoor);
  await pickupCompleteButton.click();
  await expect(page.getByText('Retirada concluida', { exact: true })).toBeVisible();

  const collectedDelivery = await page.evaluate(({ storageKey, deliveryId }) => {
    const state = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
    return state.deliveries?.find((delivery) => delivery.id === deliveryId) || null;
  }, { storageKey: STORAGE_KEY, deliveryId: storedDelivery.id });
  expect(collectedDelivery.status).toBe('collected');
  expect(collectedDelivery.pickupCloseProof?.channel).toBe(depositDoor);
  expect(collectedDelivery.collectedAt).toBeTruthy();

  await page.reload();
  await expect(page.getByRole('button', { name: /Entregar encomenda/i })).toBeVisible();
  const persistedStatus = await page.evaluate(({ storageKey, deliveryId }) => {
    const state = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
    return state.deliveries?.find((delivery) => delivery.id === deliveryId)?.status;
  }, { storageKey: STORAGE_KEY, deliveryId: storedDelivery.id });
  expect(persistedStatus).toBe('collected');
  expect(browserErrors).toEqual([]);
});
