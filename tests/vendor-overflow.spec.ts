import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Diagnóstico de overflow horizontal en el Panel Vendedor (vista "Hoy").
 * Reportado en iPhone 17e: las cards quedan "cruzadas" / cortadas a la
 * derecha. Se prueba en un viewport angosto (320px) para reproducir el
 * caso de pantallas chicas o iOS con "Pantalla ampliada" activada.
 *
 * Con LOCAL_CSS=1 inyecta el CSS del repo sobre producción para probar
 * el fix antes de deployar.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHOTS = path.join(__dirname, 'screenshots');
const COMPONENT_DIR = path.join(__dirname, '..', 'src', 'components');
const procVars = (process as any)['env'] as Record<string, string | undefined>;
const OVERRIDE_FILES = ['VendorShell.css', 'PeriodSelector.css', 'ComisionesView.css', 'RecibosApp.css'];

// Viewport angosto: iPhone SE / iPhone con "Pantalla ampliada".
test.use({ viewport: { width: 320, height: 690 } });

function repoCss(): string {
  return OVERRIDE_FILES.map(f => fs.readFileSync(path.join(COMPONENT_DIR, f), 'utf-8')).join('\n');
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
  await page.waitForSelector('.vs-main', { state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(1000);
}

/**
 * Lista los elementos que se salen del viewport por la derecha. El overflow
 * queda recortado por overflow:hidden en .vs-root/.vs-main, así que se mide
 * por getBoundingClientRect (que sí refleja la posición real) en vez de
 * scrollWidth del documento.
 */
async function overflowReport(page: Page, label: string) {
  const r = await page.evaluate(() => {
    const iw = window.innerWidth;
    const all: Array<{ tag: string; cls: string; right: number; width: number; selfClip: number }> = [];
    document.querySelectorAll('.vs-main *').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.right > iw + 1) {
        const self = el as HTMLElement;
        all.push({
          tag: el.tagName.toLowerCase(),
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 46),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          // cuánto le sobra al contenido respecto de su propia caja
          selfClip: self.scrollWidth - self.clientWidth,
        });
      }
    });
    // ordenar por ancho desc: los contenedores anchos primero
    all.sort((a, b) => b.width - a.width);
    return { iw, count: all.length, offenders: all.slice(0, 14) };
  });
  console.log(`\n=== ${label} (viewport ${r.iw}px) ===`);
  console.log(`  elementos que se salen por la derecha: ${r.count}`);
  for (const o of r.offenders) {
    console.log(`    <${o.tag} class="${o.cls}"> w=${o.width} right=${o.right}${o.selfClip > 1 ? ` ⟸ contenido +${o.selfClip}px` : ''}`);
  }
  return r;
}

test('overflow horizontal — vista Hoy', async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });

  await injectAuth(page);
  await page.screenshot({ path: path.join(SHOTS, 'ovf-A-prod-actual.png'), fullPage: true });
  const before = await overflowReport(page, 'A · producción actual');

  if (procVars['LOCAL_CSS'] === '1') {
    await page.addStyleTag({ content: repoCss() });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, 'ovf-B-con-fix.png'), fullPage: true });
    const after = await overflowReport(page, 'B · con CSS del repo (fix)');
    expect(after.count, 'ningún elemento debe salirse del viewport con el fix').toBe(0);
  }
});
