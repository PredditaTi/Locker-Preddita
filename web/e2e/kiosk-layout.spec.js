import { expect, test } from '@playwright/test';
import {
  bootKiosk,
  closeTestDoor,
} from './support/kioskTestBridge.js';

async function collectLayoutIssues(page, stage) {
  return page.evaluate((currentStage) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const root = document.documentElement;
    const body = document.body;
    const dialog = document.querySelector('[role="alertdialog"]');
    const scope = dialog || document.querySelector('.public-kiosk-host') || document;
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const describe = (element) => {
      const text = (element.getAttribute('aria-label') || element.textContent || element.tagName)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
      return `${element.tagName.toLowerCase()}[${text || 'sem nome'}]`;
    };
    const hasScrollableAncestor = (element) => {
      let current = element.parentElement;
      while (current && current !== body && current !== root) {
        const style = window.getComputedStyle(current);
        const canScroll = ['auto', 'scroll'].includes(style.overflowY)
          && current.scrollHeight > current.clientHeight + 1;
        if (canScroll) return true;
        current = current.parentElement;
      }
      return false;
    };
    const controls = [...scope.querySelectorAll('button, input, select, textarea')].filter(isVisible);
    const clippedControls = controls.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      const clippedX = rect.left < -1 || rect.right > viewport.width + 1;
      const clippedY = rect.top < -1 || rect.bottom > viewport.height + 1;
      const clipped = clippedX || (clippedY && !hasScrollableAncestor(element));
      return clipped ? [describe(element)] : [];
    });
    const textElements = [...scope.querySelectorAll('button, h1, h2, p, strong, span, label')]
      .filter(isVisible);
    const clippedText = textElements.flatMap((element) => {
      const style = window.getComputedStyle(element);
      const clipsX = ['hidden', 'clip'].includes(style.overflowX);
      const clipsY = ['hidden', 'clip'].includes(style.overflowY);
      const overflows = (clipsX && element.scrollWidth > element.clientWidth + 2)
        || (clipsY && element.scrollHeight > element.clientHeight + 2);
      return overflows ? [describe(element)] : [];
    });
    const overlaps = [];

    for (let firstIndex = 0; firstIndex < controls.length; firstIndex += 1) {
      const first = controls[firstIndex];
      const firstRect = first.getBoundingClientRect();
      for (let secondIndex = firstIndex + 1; secondIndex < controls.length; secondIndex += 1) {
        const second = controls[secondIndex];
        const secondRect = second.getBoundingClientRect();
        const width = Math.min(firstRect.right, secondRect.right) - Math.max(firstRect.left, secondRect.left);
        const height = Math.min(firstRect.bottom, secondRect.bottom) - Math.max(firstRect.top, secondRect.top);
        if (width > 2 && height > 2) {
          overlaps.push(`${describe(first)} sobre ${describe(second)}`);
        }
      }
    }

    const unnamedControls = controls.flatMap((element) => {
      const name = (
        element.getAttribute('aria-label')
        || element.getAttribute('title')
        || [...(element.labels || [])].map((label) => label.textContent).join(' ')
        || element.textContent
        || element.value
        || ''
      ).trim();
      return name ? [] : [describe(element)];
    });
    const documentOverflow = {
      x: Math.max(root.scrollWidth, body.scrollWidth) - viewport.width,
      y: Math.max(root.scrollHeight, body.scrollHeight) - viewport.height,
    };

    return {
      stage: currentStage,
      viewport,
      documentOverflow,
      clippedControls,
      clippedText,
      overlaps,
      unnamedControls,
    };
  }, stage);
}

async function expectFocusVisible(page) {
  const firstButton = page.locator('button:visible:not(:disabled)').first();
  await firstButton.focus();
  const focusStyle = await firstButton.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
    };
  });
  const hasOutline = focusStyle.outlineStyle !== 'none' && focusStyle.outlineWidth !== '0px';
  const hasShadow = focusStyle.boxShadow !== 'none';
  expect(hasOutline || hasShadow, `controle sem foco visivel: ${JSON.stringify(focusStyle)}`).toBe(true);
}

async function recordLayout(page, findings, stage) {
  const result = await collectLayoutIssues(page, stage);
  if (
    result.documentOverflow.x > 1
    || result.documentOverflow.y > 1
    || result.clippedControls.length
    || result.clippedText.length
    || result.overlaps.length
    || result.unnamedControls.length
  ) {
    findings.push(result);
  }
}

test('telas publicas permanecem legiveis e dentro do viewport', async ({ page }, testInfo) => {
  const browserErrors = await bootKiosk(page);
  const findings = [];

  await expect(page.getByRole('button', { name: /Entregar encomenda/i })).toBeVisible();
  await expectFocusVisible(page);
  await recordLayout(page, findings, 'inicio');

  await page.getByRole('button', { name: /Entregar encomenda/i }).click();
  await expect(page.getByRole('heading', { name: 'Qual e o apartamento?' })).toBeVisible();
  await recordLayout(page, findings, 'apartamento');

  const apartmentPad = page.locator('.public-apartment-input .public-number-pad');
  for (const digit of ['2', '0', '3']) {
    await apartmentPad.getByRole('button', { name: digit, exact: true }).click();
  }
  await expect(page.getByRole('textbox', { name: 'Apartamento', exact: true })).toHaveValue('203');
  await page.getByRole('button', { name: 'Apartamento 203', exact: true }).click();
  await expect(page.locator('.public-confirm-card strong')).toContainText('203');
  await expect(page.getByRole('button', { name: 'Abrir porta', exact: true })).toBeVisible();
  await recordLayout(page, findings, 'confirmacao');

  await page.getByRole('button', { name: 'Corrigir', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Qual e o apartamento?' })).toBeVisible();
  await page.getByRole('button', { name: 'Apartamento 203', exact: true }).click();
  await page.getByRole('button', { name: 'Abrir porta', exact: true }).click();

  const openDoorHero = page.locator('.public-door-hero strong');
  await expect(openDoorHero).toContainText(/^Porta \d+$/);
  const depositDoor = Number((await openDoorHero.textContent()).match(/\d+/)?.[0]);
  const storedButton = page.getByRole('button', { name: 'Item guardado', exact: true });
  await expect(storedButton).toBeEnabled();
  await recordLayout(page, findings, 'porta-aberta');

  await closeTestDoor(page, depositDoor);
  await storedButton.click();
  await expect(page.getByRole('heading', { name: 'Pronto', exact: true })).toBeVisible();
  await recordLayout(page, findings, 'sucesso');

  await page.getByRole('button', { name: 'Nova entrega', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Qual e o apartamento?' })).toBeVisible();
  await recordLayout(page, findings, 'nova-entrega');
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();

  await page.getByRole('button', { name: /Retirar encomenda/i }).click();
  await expect(page.getByRole('heading', { name: 'Digite seu PIN' })).toBeVisible();
  await recordLayout(page, findings, 'pin');

  await page.getByRole('tab', { name: 'QR', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'PIN', exact: true })).toBeVisible();
  await recordLayout(page, findings, 'qr');
  await page.getByRole('tab', { name: 'PIN', exact: true }).click();

  const pinPad = page.locator('.public-number-pad--pin');
  for (const digit of '000000') {
    await pinPad.getByRole('button', { name: digit, exact: true }).click();
  }
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Retirada nao autorizada' })).toBeVisible();
  await recordLayout(page, findings, 'erro');

  expect(
    findings,
    `problemas de layout em ${testInfo.project.name}:\n${JSON.stringify(findings, null, 2)}`
  ).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test('auditoria detecta controle movido para fora da tela', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'kiosk-1024x600',
    'A falha controlada precisa ser demonstrada apenas no viewport de referencia.'
  );
  await bootKiosk(page);
  await page.addStyleTag({
    content: '.kiosk-v4-action:first-child { transform: translateX(-1200px) !important; }',
  });

  const result = await collectLayoutIssues(page, 'falha-controlada');
  expect(result.clippedControls.some((control) => control.includes('Entregar encomenda'))).toBe(true);
});
