# Validación del motor de Cruce carpeta — caso real junio 2026

Certificación del motor `server-lib/cruceCarpeta.ts` contra la conciliación
manual de junio 2026 (hecha y verificada a mano el 01/07/2026, ajustada por Mati).

## Archivos
- `cte_junio_2026.xlsx` — el Sheet real de carpeta de junio (Drive "Cte Clientes JUNIO 2026").
- `sistema_all.json` — los 298 clientes de la pestaña SISTEMA = cierre IM al 30/06.
- `recon_full.json` — el resultado del cruce manual (verificado por auditoría multi-agente).
- `validar_junio.mjs` — harness: corre el motor con esos datos y compara.

## Correr
```bash
npm run build:server
INFOMANAGER_CLIENT_SECRET=dummy SUPABASE_URL=http://localhost SUPABASE_SERVICE_KEY=dummy   node docs/validacion-cruce-junio2026/validar_junio.mjs
```
(las env dummy evitan el guard fail-loud de infomanager.ts; el harness no toca red)

## Resultado esperado (certificado 08/07/2026, commit 0fb244c)
- "Diferencias del manual reproducidas por el motor: 49" / "No reproducidas: ninguna"
- Única extra: ANDREA/WALTER→ORDOÑEZ WALTER marcada `tentativo` (en el manual se
  descartó por juicio humano — comportamiento deseado).
- SARACHO excluida por fecha 21/11 (typo) y listada.

Si un cambio futuro del motor rompe alguno de estos números, ese cambio
degrada el matching con datos reales.
