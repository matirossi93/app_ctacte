import { test, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Test visual para iPhone 17 Pro reportado por el user (Mati).
 * Toma screenshots de las pantallas principales para detectar overflow,
 * inputs auto-zoomeados y problemas con safe-area (dynamic island).
 *
 * Viewport iPhone 17 Pro: 402 x 874 CSS px @ DPR 3, hasSafeArea true.
 *
 * Requiere TEST_JWT + TEST_USER en env (los pasa el user desde su browser).
 * Con LOCAL_CSS=1 inyecta el CSS del repo sobre producción para validar el
 * fix antes de deployar.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHOTS = path.join(__dirname, 'screenshots', 'iphone-17-pro');
fs.mkdirSync(SHOTS, { recursive: true });

const procVars = (process as any)['env'] as Record<string, string | undefined>;
const LOCAL_CSS = procVars['LOCAL_CSS'] === '1';
const COMPONENT_DIR = path.join(__dirname, '..', 'src', 'components');
const OVERRIDE_FILES = ['VendorShell.css', 'ActividadApp.css', 'RecibosApp.css', 'PeriodSelector.css', 'ComisionesView.css'];

function repoCss(): string {
  const indexCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.css'), 'utf-8');
  const componentCss = OVERRIDE_FILES.map(f => {
    const p = path.join(COMPONENT_DIR, f);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
  }).join('\n');
  return indexCss + '\n' + componentCss;
}

// iPhone 17 Pro: 402x874 viewport, 3x DPR, safe-area top ~59px (dynamic island).
test.use({
  viewport: { width: 402, height: 874 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
});

async function injectAuth(page: Page) {
  const jwt = procVars['TEST_JWT'];
  const userJson = procVars['TEST_USER'];
  if (!jwt || !userJson) throw new Error('Faltan TEST_JWT / TEST_USER');
  await page.addInitScript(({ jwt, userJson }) => {
    localStorage.setItem('auth_token', jwt);
    localStorage.setItem('auth_user', userJson);
    localStorage.setItem('auth_mode', 'jwt');
  }, { jwt, userJson });
}

/** Inyecta el CSS del repo DESPUÉS del primer render para validar fixes
 *  sin deployar. `addStyleTag` se agrega al `<head>` actual, asegurando
 *  que el style del repo gane por orden de cascada sobre lo de producción. */
async function applyLocalCss(page: Page) {
  if (!LOCAL_CSS) return;
  await page.addStyleTag({ content: repoCss() });
  // Pequeño delay para que el browser re-layoutee.
  await page.waitForTimeout(200);
}

/** Detecta overflow horizontal: elementos cuyo right > viewport.innerWidth. */
async function reportOverflow(page: Page, label: string) {
  const r = await page.evaluate(() => {
    const iw = window.innerWidth;
    const offenders: Array<{ tag: string; cls: string; right: number; width: number }> = [];
    document.querySelectorAll('body *').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.right > iw + 1) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 50),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        });
      }
    });
    offenders.sort((a, b) => b.right - a.right);
    return { iw, count: offenders.length, offenders: offenders.slice(0, 10) };
  });
  console.log(`\n=== ${label} (vw ${r.iw}) ===  overflow: ${r.count}`);
  for (const o of r.offenders) {
    console.log(`  <${o.tag} class="${o.cls}"> w=${o.width} right=${o.right}`);
  }
  return r;
}

/** Lista inputs/select/textarea con font-size computado < 16px (auto-zoom iOS). */
async function reportSmallFontInputs(page: Page, label: string) {
  const r = await page.evaluate(() => {
    const small: Array<{ tag: string; cls: string; fontSize: number; type: string }> = [];
    document.querySelectorAll('input, textarea, select').forEach(el => {
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 16) {
        small.push({
          tag: el.tagName.toLowerCase(),
          type: (el as HTMLInputElement).type || '',
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 50),
          fontSize: fs,
        });
      }
    });
    return { count: small.length, items: small.slice(0, 20) };
  });
  console.log(`\n=== ${label}: inputs con font-size<16px (auto-zoom iOS) ===  total: ${r.count}`);
  for (const i of r.items) {
    console.log(`  <${i.tag} type="${i.type}" class="${i.cls}"> ${i.fontSize}px`);
  }
  return r;
}

test('login screen — iPhone 17 Pro', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await applyLocalCss(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, '01-login.png'), fullPage: false });
  await reportOverflow(page, 'login');
  await reportSmallFontInputs(page, 'login');
});

test('hoy view — iPhone 17 Pro', async ({ page }) => {
  await injectAuth(page);
  await page.goto('/');
  await page.waitForSelector('.vs-main', { state: 'visible', timeout: 30_000 });
  await applyLocalCss(page);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, '02-hoy.png'), fullPage: false });
  await page.screenshot({ path: path.join(SHOTS, '02-hoy-full.png'), fullPage: true });
  await reportOverflow(page, 'hoy');
  await reportSmallFontInputs(page, 'hoy');
});

test('cobranzas view — iPhone 17 Pro', async ({ page }) => {
  await injectAuth(page);
  await page.goto('/');
  await page.waitForSelector('.vs-main', { state: 'visible', timeout: 30_000 });
  await applyLocalCss(page);
  await page.click('.vs-nav-btn:has-text("Cobranzas")');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SHOTS, '03-cobranzas.png'), fullPage: false });
  await reportOverflow(page, 'cobranzas');
  await reportSmallFontInputs(page, 'cobranzas');
});

test('actividad — nuevo modal — iPhone 17 Pro', async ({ page }) => {
  await injectAuth(page);
  await page.goto('/');
  await page.waitForSelector('.vs-main', { state: 'visible', timeout: 30_000 });
  await applyLocalCss(page);
  await page.click('.vs-nav-btn:has-text("Actividad")');
  await page.waitForTimeout(1500);
  // FAB de actividad: .vs-fab-act
  await page.click('.vs-fab-act');
  await page.waitForSelector('.vs-newact', { state: 'visible', timeout: 5000 });
  // Click en "Promesa" para que aparezcan fecha+hora
  await page.click('.vs-newact-tipo:has-text("Promesa")');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, '04-actividad-nueva.png'), fullPage: false });
  await reportOverflow(page, 'actividad-nueva');
  await reportSmallFontInputs(page, 'actividad-nueva');
  // Cargar fecha mañana para que aparezca hora
  await page.evaluate(() => {
    const dateInput = document.querySelector<HTMLInputElement>('.vs-newact-row input[type=date]');
    if (dateInput) {
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
      dateInput.value = tomorrow.toISOString().slice(0, 10);
      dateInput.dispatchEvent(new Event('input', { bubbles: true }));
      dateInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, '05-actividad-con-hora.png'), fullPage: false });
});

test('recibos modal — iPhone 17 Pro', async ({ page }) => {
  await injectAuth(page);
  await page.goto('/');
  await page.waitForSelector('.vs-main', { state: 'visible', timeout: 30_000 });
  await applyLocalCss(page);
  // FAB global de recibos: el primer botón .vs-fab que NO sea .vs-fab-act.
  await page.locator('button.vs-fab').first().click();
  await page.waitForSelector('.recibos-shell, .rec-overlay, .rec-modal, .rec-header', { state: 'visible', timeout: 8000 }).catch(() => null);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, '06-recibos-modal.png'), fullPage: false });
  await reportOverflow(page, 'recibos-modal');
  await reportSmallFontInputs(page, 'recibos-modal');
});
