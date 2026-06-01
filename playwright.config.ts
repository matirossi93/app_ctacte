import { defineConfig, devices } from '@playwright/test';

/**
 * Config Playwright para tour de mobile.
 * Target: producción (clientes.semilleroelmanantial.com.ar).
 * Auth via JWT capturado del browser logueado del user.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'tests/playwright-report' }]],
  use: {
    baseURL: 'https://clientes.semilleroelmanantial.com.ar',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'iphone-13',
      use: { ...devices['iPhone 13'] },
      testIgnore: /(recibos-debug|vendor-overflow|historial-compras)\.spec\.ts/,
    },
    {
      // Viewport del iPhone 13 pero corriendo en Edge del sistema
      // (msedge channel) — no requiere descargar el browser WebKit.
      name: 'iphone-edge',
      use: {
        ...devices['iPhone 13'],
        defaultBrowserType: 'chromium',
        channel: 'msedge',
      },
      testMatch: /(recibos-debug|vendor-overflow|historial-compras)\.spec\.ts/,
    },
    {
      // iPhone 17 Pro: 402x874 viewport @ 3x DPR. Corre en Edge para no tener
      // que descargar WebKit. El spec setea su propio viewport con test.use().
      name: 'iphone-17-pro',
      use: {
        defaultBrowserType: 'chromium',
        channel: 'msedge',
      },
      testMatch: /iphone-17-pro\.spec\.ts/,
    },
  ],
});
