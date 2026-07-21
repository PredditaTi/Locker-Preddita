import { expect, test } from '@playwright/test';
import { bootKiosk } from './support/kioskTestBridge.js';

const AUDIO_STORAGE_KEY = 'preddita_kiosk_audio_preferences_v1';

async function audioEvents(page, type) {
  return page.evaluate((eventType) => (
    window.__predditaAudioEvents.filter((event) => event.type === eventType)
  ), type);
}

test('audio inicia desligado, toca uma vez por etapa e interrompe a anterior', async ({ page }) => {
  const browserErrors = await bootKiosk(page, { audioProbe: true });
  expect(await audioEvents(page, 'play')).toEqual([]);

  await page.getByRole('button', { name: 'Configurar audio. Desativado' }).click();
  const dialog = page.getByRole('dialog', { name: 'Orientacao sonora' });
  const audioSwitch = dialog.getByRole('switch');
  await audioSwitch.click();

  await expect(page.getByRole('button', { name: 'Configurar audio. Ativado' })).toBeVisible();
  let plays = await audioEvents(page, 'play');
  expect(plays).toHaveLength(1);
  expect(plays[0].source).toContain('/home-');
  expect(plays[0].volume).toBe(0.45);

  await dialog.getByRole('button', { name: 'Concluir' }).click();
  await page.getByRole('button', { name: /Entregar encomenda/i }).click();
  plays = await audioEvents(page, 'play');
  expect(plays).toHaveLength(2);
  expect(plays[1].source).toContain('/courier-choice-');
  expect(await audioEvents(page, 'pause')).toHaveLength(1);

  const apartmentInput = page.getByRole('textbox', { name: 'Apartamento' });
  await apartmentInput.fill('1');
  await apartmentInput.fill('10');
  expect(await audioEvents(page, 'play')).toHaveLength(2);
  expect(browserErrors).toEqual([]);
});

test('controle limita e persiste somente volume e estado de audio', async ({ page }) => {
  const browserErrors = await bootKiosk(page, { audioProbe: true });
  await page.getByRole('button', { name: 'Configurar audio. Desativado' }).click();
  const dialog = page.getByRole('dialog', { name: 'Orientacao sonora' });
  await dialog.getByRole('switch').click();

  const slider = dialog.getByRole('slider', { name: 'Volume da orientacao sonora' });
  await slider.fill('65');
  await expect(slider).toHaveValue('65');

  const stored = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key)), AUDIO_STORAGE_KEY);
  expect(stored).toEqual({ muted: false, volume: 0.65 });

  await dialog.getByRole('button', { name: 'Ouvir novamente' }).click();
  let plays = await audioEvents(page, 'play');
  expect(plays.at(-1).volume).toBe(0.65);

  await dialog.getByRole('switch').click();
  await expect(slider).toBeDisabled();
  const mutedStored = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key)), AUDIO_STORAGE_KEY);
  expect(mutedStored).toEqual({ muted: true, volume: 0.65 });
  expect(await audioEvents(page, 'pause')).not.toHaveLength(0);

  await page.reload();
  await page.getByRole('button', { name: 'Configurar audio. Desativado' }).click();
  const reloadedDialog = page.getByRole('dialog', { name: 'Orientacao sonora' });
  await expect(reloadedDialog.getByRole('switch')).not.toBeChecked();
  await expect(reloadedDialog.getByRole('slider', { name: 'Volume da orientacao sonora' })).toHaveValue('65');
  expect(browserErrors).toEqual([]);
});
