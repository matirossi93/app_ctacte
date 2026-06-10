/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  },
  test: {
    // tests/ contiene specs de Playwright (E2E) — vitest no debe levantarlos.
    // Los unitarios viven junto al código (server-lib/*.test.ts, src/**).
    exclude: ['tests/**', 'node_modules/**', 'dist/**', 'dist-server/**'],
  },
})
