import { test, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Tour de mobile que recorre todas las pantallas de la app y captura
 * screenshots para análisis visual de problemas de diseño.
 *
 * Auth: lee JWT y user JSON de variables de entorno TEST_JWT y TEST_USER.
 * Si LOCAL_CSS=1, inyecta los CSS modificados del repo sobre la página de
 * producción para previsualizar fixes antes de pushear.
 * Screenshots quedan en tests/screenshots/ con nombres descriptivos.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const procVars = (process as any)['env'] as Record<string, string | undefined>;

const COMPONENT_DIR = path.join(__dirname, '..', 'src', 'components');
const OVERRIDE_FILES = [
  'VendorShell.css',
  'PeriodSelector.css',
  'ComisionesView.css',
  'RecibosApp.css',
];

function readOverrideCss(): string {
  return OVERRIDE_FILES
    .map(f => fs.readFileSync(path.join(COMPONENT_DIR, f), 'utf-8'))
    .join('\n\n/* --- next file --- */\n\n');
}

test.beforeAll(async () => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
});

async function injectAuth(page: Page) {
  const jwt = procVars['TEST_JWT'];
  const userJson = procVars['TEST_USER'];
  if (!jwt) throw new Error('Falta variable TEST_JWT');
  if (!userJson) throw new Error('Falta variable TEST_USER');

  await page.addInitScript(({ jwt, userJson }) => {
    localStorage.setItem('auth_token', jwt);
    localStorage.setItem('auth_user', userJson);
    localStorage.setItem('auth_mode', 'jwt');
  }, { jwt, userJson });
  await page.goto('/');
  await page.waitForLoadState('networkidle', { timeout: 30_000 });
  await page.waitForSelector('.vs-nav-btn', { state: 'visible', timeout: 20_000 });

  if (procVars['LOCAL_CSS'] === '1') {
    await page.addStyleTag({ content: readOverrideCss() });
  }
  await page.waitForTimeout(800);
}

async function snap(page: Page, name: string) {
  const file = path.join(SCREENSHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  📸 ${name}.png`);
}

async function clickTab(page: Page, label: string) {
  const btn = page.locator('.vs-nav-btn', { hasText: label });
  await btn.click({ timeout: 10_000 });
  await page.waitForTimeout(1500);
}

test.describe('Mobile tour — app_ctacte panel vendedor', () => {

  test('tab Hoy', async ({ page }) => {
    await injectAuth(page);
    await snap(page, '01-hoy-default');
  });

  test('tab Cobranzas', async ({ page }) => {
    await injectAuth(page);
    await clickTab(page, 'Cobranzas');
    await snap(page, '02a-cobranzas-default');

    const buckets = ['reciente', 'medio', 'vencido'];
    for (const b of buckets) {
      const btn = page.locator('button', { hasText: new RegExp(b, 'i') }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(800);
        await snap(page, `02b-cobranzas-bucket-${b}`);
      }
    }

    const search = page.locator('input[placeholder*="usca" i], input[type="search"]').first();
    if (await search.isVisible().catch(() => false)) {
      await search.click();
      await search.fill('cli');
      await page.waitForTimeout(500);
      await snap(page, '02c-cobranzas-search-active');
    }
  });

  test('tab Objetivos', async ({ page }) => {
    await injectAuth(page);
    await clickTab(page, 'Objetivos');
    await snap(page, '03a-objetivos-default');

    const periodPill = page.locator('button', { hasText: /mayo|abril|marzo|febrero|enero/i }).first();
    if (await periodPill.isVisible().catch(() => false)) {
      await periodPill.click();
      await page.waitForTimeout(500);
      await snap(page, '03b-objetivos-period-popover');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.waitForTimeout(500);
    await snap(page, '03c-objetivos-scrolled-mid');

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    await snap(page, '03d-objetivos-scrolled-bottom');
  });

  test('tab Comisiones', async ({ page }) => {
    await injectAuth(page);
    await clickTab(page, 'Comisiones');
    await page.waitForTimeout(8000);
    await snap(page, '04a-comisiones-default');

    const ranking = page.locator('.cv-row').first();
    if (await ranking.isVisible().catch(() => false)) {
      await ranking.click();
      await page.waitForTimeout(500);
      await snap(page, '04b-comisiones-drill-down-expandido');
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    await snap(page, '04c-comisiones-scrolled-bottom');
  });

  test('tab Actividad', async ({ page }) => {
    await injectAuth(page);
    await clickTab(page, 'Actividad');
    await page.waitForTimeout(2000);
    await snap(page, '05a-actividad-default');

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    await snap(page, '05b-actividad-scrolled-bottom');
  });

  test('FAB recibos modal', async ({ page }) => {
    await injectAuth(page);
    const fab = page.locator('.vs-fab').first();
    if (await fab.isVisible().catch(() => false)) {
      await fab.click();
      await page.waitForTimeout(1500);
      await snap(page, '06-recibos-modal-default');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
  });

  test('PeriodSelector tab Corte', async ({ page }) => {
    await injectAuth(page);
    await clickTab(page, 'Comisiones');
    await page.waitForTimeout(5000);

    const periodPill = page.locator('button', { hasText: /mayo|abril/i }).first();
    if (await periodPill.isVisible().catch(() => false)) {
      await periodPill.click();
      await page.waitForTimeout(500);
      await snap(page, '07a-period-popover-mes');

      const corteTab = page.locator('button', { hasText: /corte/i }).first();
      if (await corteTab.isVisible().catch(() => false)) {
        await corteTab.click();
        await page.waitForTimeout(500);
        await snap(page, '07b-period-popover-corte');
      }
    }
  });
});
