import { expect, test } from '@playwright/test';
import { bootKiosk } from './support/kioskTestBridge.js';

function relativeLuminance([red, green, blue]) {
  const channels = [red, green, blue].map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function parseRgb(value) {
  return (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
}

test('home V4 oferece marca, ajuda e controles com alvo estavel', async ({ page }) => {
  const browserErrors = await bootKiosk(page);
  await expect(page.getByLabel(/PREDDITA Locker/i)).toBeVisible();

  const audioButton = page.getByRole('button', { name: 'Audio indisponivel nesta versao' });
  await expect(audioButton).toBeDisabled();
  await expect(audioButton).toHaveAttribute('title', /proxima etapa/i);

  const helpButton = page.getByRole('button', { name: 'Ajuda', exact: true });
  await helpButton.click();
  const dialog = page.getByRole('dialog', { name: 'Precisa de ajuda?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('portaria');
  await expect(dialog.getByRole('button', { name: 'Fechar ajuda' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Entendi' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Fechar ajuda' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(helpButton).toBeFocused();

  for (const button of await page.locator('.kiosk-v4-action').all()) {
    const box = await button.boundingBox();
    expect(box?.height || 0).toBeGreaterThanOrEqual(64);
    expect(box?.width || 0).toBeGreaterThanOrEqual(64);
  }
  expect(browserErrors).toEqual([]);
});

test('home V4 mantem contraste AA nos textos principais', async ({ page }) => {
  await bootKiosk(page);
  const samples = await page.locator('.kiosk-v4-home-title, .kiosk-v4-action-title, .kiosk-v4-action-meta')
    .evaluateAll((elements) => elements.map((element) => {
      const style = getComputedStyle(element);
      const parent = element.closest('.kiosk-v4-action') || element.parentElement;
      return {
        text: element.textContent.trim(),
        color: style.color,
        background: getComputedStyle(parent).backgroundColor,
        fontSize: Number.parseFloat(style.fontSize),
        fontWeight: Number.parseFloat(style.fontWeight) || 400,
      };
    }));

  for (const sample of samples) {
    const ratio = contrastRatio(parseRgb(sample.color), parseRgb(sample.background));
    const isLarge = sample.fontSize >= 24 || (sample.fontSize >= 18.66 && sample.fontWeight >= 700);
    expect(ratio, `${sample.text}: contraste ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(isLarge ? 3 : 4.5);
  }
});
