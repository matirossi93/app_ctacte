import { defineConfig } from 'vitest/config'

// Config de vitest separada de vite.config.ts a propósito: poner el campo `test`
// en vite.config.ts rompe `tsc -b` del build de producción (Dockerfile). Acá no
// pasa por tsc (tsconfig.node.json solo incluye vite.config.ts), vitest lo lee
// en runtime. Los tests unitarios viven junto al código (server-lib/*.test.ts,
// src/**); tests/ contiene specs de Playwright (E2E) que vitest NO debe levantar.
export default defineConfig({
  test: {
    exclude: ['tests/**', 'node_modules/**', 'dist/**', 'dist-server/**'],
  },
})
