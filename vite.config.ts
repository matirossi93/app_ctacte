import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// La config de vitest (exclude de los specs Playwright) vive en vitest.config.ts
// para no meter el campo `test` acá: tiparlo en vite.config.ts rompía `tsc -b`
// del build ('test' does not exist in type UserConfigExport).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
})
