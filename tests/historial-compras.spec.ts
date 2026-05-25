import { test, expect } from '@playwright/test';

/**
 * Validación de la vista de historial de compras dentro del expand de
 * un cliente en la tab Objetivos.
 *
 * Auth: necesita un JWT válido en localStorage (mismo enfoque que
 * recibos-debug.spec.ts y vendor-overflow.spec.ts).
 *
 * Setear vía variable de entorno o hardcodear con un token local:
 *   E2E_JWT=eyJ... npx playwright test historial-compras
 */

const JWT = process.env.E2E_JWT;

test.skip(!JWT, 'Necesita E2E_JWT para correr');

test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate((t) => localStorage.setItem('token', t!), JWT!);
});

test('vendedor expande un cliente y ve top productos + compras recientes', async ({ page }) => {
    await page.goto('/');
    // Ir a la tab Objetivos
    await page.getByRole('button', { name: /objetivos/i }).click();

    // Esperar lista de clientes
    await page.waitForSelector('.vs-cliente-obj', { timeout: 15000 });

    // Expandir el primer cliente
    const firstCliente = page.locator('.vs-cliente-obj').first();
    await firstCliente.locator('.vs-cliente-obj-head').click();

    // Validar que aparece la sección de historial (loading o cargada)
    await expect(firstCliente.locator('.vs-historial-loading, .vs-historial-top, .vs-historial-empty-state')).toBeVisible({ timeout: 10000 });

    // Si no es empty state, debería haber al menos una factura
    const isEmpty = await firstCliente.locator('.vs-historial-empty-state').isVisible();
    if (!isEmpty) {
        await expect(firstCliente.locator('.vs-historial-top')).toBeVisible({ timeout: 15000 });
        await expect(firstCliente.locator('.vs-historial-facturas')).toBeVisible();
    }
});

test('expandir y colapsar no refetchea (cache local del componente)', async ({ page }) => {
    let fetchCount = 0;
    await page.route('**/api/clientes/*/historial-compras*', (route) => {
        fetchCount++;
        route.continue();
    });

    await page.goto('/');
    await page.getByRole('button', { name: /objetivos/i }).click();
    await page.waitForSelector('.vs-cliente-obj', { timeout: 15000 });
    const firstCliente = page.locator('.vs-cliente-obj').first();

    // Abrir
    await firstCliente.locator('.vs-cliente-obj-head').click();
    await page.waitForTimeout(2000);
    expect(fetchCount).toBe(1);

    // Cerrar
    await firstCliente.locator('.vs-cliente-obj-head').click();
    await page.waitForTimeout(500);

    // Abrir de nuevo
    await firstCliente.locator('.vs-cliente-obj-head').click();
    await page.waitForTimeout(1500);
    expect(fetchCount).toBe(1); // sigue siendo 1, no refetcheó
});
