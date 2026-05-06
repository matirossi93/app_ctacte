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
    },
  ],
});
