import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Test de diagnóstico para el modal "Mis comprobantes" / "Recibos pendientes".
 * Investiga dos reportes:
 *  (a) header tapado por el status bar (notch) en iPhone PWA standalone.
 *  (b) panel descentrado hacia la derecha.
 *
 * Playwright NO emula el notch, así que medimos primero el estado real
 * (env()=0) y después inyectamos el CSS del repo con env(safe-area-inset-*)
 * reemplazado por valores fijos del iPhone 13 para simular la PWA standalone.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHOTS = path.join(__dirname, 'screenshots');
const COMPONENT_DIR = path.join(__dirname, '..', 'src', 'components');
const procVars = (process as any)['env'] as Record<string, string | undefined>;

// Insets reales de un iPhone 13 como PWA standalone en portrait.
const SAT = 47; // safe-area-inset-top
const SAB = 34; // safe-area-inset-bottom

const OVERRIDE_FILES = ['VendorShell.css', 'PeriodSelector.css', 'ComisionesView.css', 'RecibosApp.css'];

function repoCss(simulateNotch: boolean): string {
  let css = OVERRIDE_FILES.map(f => fs.readFileSync(path.join(COMPONENT_DIR, f), 'utf-8')).join('\n');
  if (simulateNotch) {
    css = css
      .replace(/env\(safe-area-inset-top\)/g, `${SAT}px`)
      .replace(/env\(safe-area-inset-bottom\)/g, `${SAB}px`)
      .replace(/env\(safe-area-inset-left\)/g, '0px')
      .replace(/env\(safe-area-inset-right\)/g, '0px');
  }
  return css;
}

async function injectAuth(page: Page) {
  const jwt = procVars['TEST_JWT'];
  const userJson = procVars['TEST_USER'];
  if (!jwt || !userJson) throw new Error('Faltan TEST_JWT / TEST_USER');
  await page.addInitScript(({ jwt, userJson }) => {
    localStorage.setItem('auth_token', jwt);
    localStorage.setItem('auth_user', userJson);
    localStorage.setItem('auth_mode', 'jwt');
  }, { jwt, userJson });
  await page.goto('/');
  await page.waitForLoadState('networkidle', { timeout: 30_000 });
  await page.waitForSelector('.vs-fab', { state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(600);
}

async function openModal(page: Page) {
  await page.locator('.vs-fab').first().click();
  await page.waitForSelector('.recibos-modal', { state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(600);
}

/** Mide geometría del modal y reporta descentrado / overflow horizontal. */
async function measure(page: Page, label: string) {
  const m = await page.evaluate(() => {
    const q = (s: string) => document.querySelector(s);
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    return {
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      docScrollW: document.documentElement.scrollWidth,
      bodyScrollW: document.body.scrollWidth,
      overlay: rect(q('.recibos-overlay')),
      modal: rect(q('.recibos-modal')),
      header: rect(q('.recibos-header')),
      headerH2: rect(q('.recibos-header h2')),
      body: rect(q('.recibos-body')),
      firstItem: rect(q('.rec-item, .rec-factura')),
    };
  });
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(m, null, 2));
  const horizOverflow = m.docScrollW > m.innerW;
  const modalOffCenter = m.modal ? (m.modal.x !== 0 || m.modal.x + m.modal.w !== m.innerW) : true;
  console.log(`  overflow horizontal: ${horizOverflow ? `SÍ (scrollW ${m.docScrollW} > innerW ${m.innerW})` : 'no'}`);
  console.log(`  modal descentrado: ${modalOffCenter ? `SÍ (x=${m.modal?.x}, x+w=${(m.modal?.x ?? 0) + (m.modal?.w ?? 0)}, innerW=${m.innerW})` : 'no'}`);
  if (m.header && m.header.y < SAT) {
    console.log(`  ⚠️ header arranca en y=${m.header.y} — bajo el notch de ${SAT}px (tapado por status bar)`);
  }
  return m;
}

test('diagnostico modal recibos', async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });

  // ---- A. Estado actual de producción (sin notch emulado) ----
  await injectAuth(page);
  await openModal(page);
  await page.screenshot({ path: path.join(SHOTS, 'dbg-A-prod-actual.png') });
  await measure(page, 'A · producción actual (env()=0)');

  // ---- B. Producción + CSS del repo, con notch simulado ----
  await page.addStyleTag({ content: repoCss(true) });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'dbg-B-fix-notch-simulado.png') });
  await measure(page, 'B · CSS del repo + notch iPhone 13 simulado');
});
