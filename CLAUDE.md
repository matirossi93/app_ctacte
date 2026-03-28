# App Cuenta Corriente

## Stack
- React + TypeScript + Vite (frontend en src/)
- Express + TypeScript (server en server.ts)
- Deploy: Hostinger EasyPanel (Docker)
- Data: CSV en /data + InfoManager API

## Comandos
- `npm run dev` — dev local
- `npm run build` — frontend + server
- Producción: dist-server/server.js

## Reglas
- Usa papaparse para CSV
- Tiene Dockerfile para deploy en EasyPanel
- Nginx config en /nginx para reverse proxy
