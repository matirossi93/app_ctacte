# Historial de compras por cliente para vendedor

**Fecha:** 2026-05-25
**Estado:** Diseño aprobado, pendiente plan de implementación
**Repo:** `app_ctacte`

## Problema

El vendedor abre la tab **Objetivos** y dentro de "Objetivo por cliente" ve una tarjeta expandible por cliente con info comercial (dirección, repartidor, condición de pago) e histórico de facturación (mes pasado, prom 3m, saldo ctacte). Cuando sale a vender no tiene a mano qué fue lo que el cliente compró últimamente ni qué productos repite, así que pierde la oportunidad de armar pedidos sugerentes ("¿llevás Mix Energético hoy también?") y no detecta caídas en productos específicos.

## Objetivo

Sumar al detalle expandible de cada cliente dos vistas nuevas, derivadas de los últimos 3 meses de compras reales:
1. **Lo que más compra** — dos rankings cortos: top 5 por importe neto + top 5 por frecuencia (en cuántas facturas aparece).
2. **Compras recientes** — lista plegada de las últimas 10 facturas con su desglose de líneas, expandible a todas las del trimestre.

## Alcance

Lo que cambia:
- Backend: 1 endpoint nuevo `GET /api/clientes/:cod/historial-compras` que reusa el cache mensual existente.
- Frontend: extensión del componente `ClienteObjetivoCard` con dos secciones nuevas dentro del bloque expandido.

Lo que NO cambia:
- No tocamos la tab "Cobranzas", "Hoy", "Comisiones" ni "Actividad".
- No tocamos la sincronización con IM ni el cron de prewarm.
- No tocamos la tabla `comprobantes_pago` ni Supabase.
- No agregamos nuevos roles ni permisos: solo se respeta lo que ya hay (vendedor ve sus clientes, admin/gerente ve todos).

## Diseño técnico

### Endpoint

```
GET /api/clientes/:cod/historial-compras?meses=3
Auth: requireJwt
```

**Validación de permisos:**
- `rol === 'admin' || rol === 'gerente'` → cualquier cliente.
- `rol === 'vendedor'` → solo si `cod_cliente` está en la lista de clientes del vendedor (mismo cruce con clientes IM que ya hace `server-lib/clientes.ts`).
- `rol === 'repartidor'` → 403. No accede a esta vista en esta iteración (decisión 25/05/26: el repartidor se queda con su shell de recibos sin información de historial comercial).
- Cualquier otro rol → 403.

**Parámetro `meses`:** por ahora siempre 3 (default y único valor aceptado). Se valida y se devuelve 400 si llega otro número. Dejamos el parámetro en la URL para no romper el contrato si en el futuro se agrega un toggle.

**Pipeline interno:**
1. Calcular los 3 meses (mes actual + 2 anteriores) a partir de `new Date()`.
2. Para cada mes, en paralelo, llamar a `getMonthlyVentasRaw` y `getMonthlyItemsRaw` (`server-lib/snapshotCache.ts`). El cache es por mes calendario con TTL 5min (actual) / 1h (pasados).
3. Filtrar cabeceras: solo Casa Central (`cod_empresa === COD_EMPRESA_CASA_CENTRAL`), tipos válidos (FA o NC, vía `clasificarCabecera`), no clientes internos (mismo set que `comisiones.ts`), y `cod_cliente === :cod`.
4. Asignar signo: FA → +1, NC → -1.
5. Mergear los items de los 3 meses; quedarse con los que pertenezcan a una cabecera filtrada.
6. Aplicar exclusión de líneas técnicas (ver sección "Filtros").
7. Construir respuesta:
   - `facturas`: array de cabeceras ordenado desc por `fecha`, cada una con sus `items` (post-exclusión técnica). Las NCs aparecen en el array y se identifican por el campo `tipo`.
   - `top_importe`: agrupar items por `cod_articulo`, sumar `importe * signo`, ordenar desc, slice top 5.
   - `top_frecuencia`: agrupar items por `cod_articulo`, contar facturas distintas (set de `id_comprobante`), ordenar desc, slice top 5. Empate se rompe por importe.
   - Para cada artículo del top: `{cod_articulo, detalle, cantidad_total, importe_total, num_facturas, ultima_compra}`.
8. Devolver `{ok: true, cod_cliente, meses: 3, facturas, top_importe, top_frecuencia, generated_at}`.

**Forma de la respuesta:**

```json
{
  "ok": true,
  "cod_cliente": 1234,
  "meses": 3,
  "rango": { "desde": "2026-03-01", "hasta": "2026-05-31" },
  "facturas": [
    {
      "id_comprobante": 87123,
      "fecha": "2026-05-25",
      "tipo": "FA",
      "tipo_factura": "A",
      "punto_venta": 1,
      "numero": 12345,
      "total_neto": 48500,
      "items": [
        { "cod_articulo": 1001, "detalle": "Mix Energético 25kg", "cantidad": 4, "importe": 32000 },
        { "cod_articulo": 1078, "detalle": "Tiernitos 25kg", "cantidad": 2, "importe": 16500 }
      ]
    },
    {
      "id_comprobante": 86988,
      "fecha": "2026-05-18",
      "tipo": "NC",
      "tipo_factura": "A",
      "punto_venta": 1,
      "numero": 78,
      "total_neto": -12000,
      "items": [ { "cod_articulo": 1078, "detalle": "Tiernitos 25kg", "cantidad": -1, "importe": -8250 } ]
    }
  ],
  "top_importe": [
    { "cod_articulo": 1001, "detalle": "Mix Energético 25kg", "cantidad_total": 18, "importe_total": 144000, "num_facturas": 9, "ultima_compra": "2026-05-25" }
  ],
  "top_frecuencia": [
    { "cod_articulo": 1078, "detalle": "Tiernitos 25kg", "cantidad_total": 24, "importe_total": 198000, "num_facturas": 12, "ultima_compra": "2026-05-22" }
  ],
  "generated_at": "2026-05-25T18:30:00Z"
}
```

### Filtros y exclusiones

**Cabeceras incluidas:** mismo set que `topArticulos` en `server-lib/comisiones.ts` — solo Casa Central, FA o NC, no clientes internos.

**Líneas técnicas excluidas** (case-insensitive, match parcial sobre `detalle`):

```ts
const PATRONES_EXCLUIR = ['flete', 'descuento', 'bonif', 'ajuste', 'redondeo', 'percepcion'];
```

Estas líneas se descartan ANTES de armar `facturas[].items`, `top_importe` y `top_frecuencia`. Si una factura queda sin líneas tras la exclusión (ej: NC pura de ajuste), igual aparece en `facturas` con `items: []` y su `total_neto` original — el vendedor ve que hubo movimiento pero sin desglose.

**Justificación:** detectar por descripción es más robusto que código duro porque IM ha cambiado códigos en el pasado (caso ya documentado: hipoclorito 99002 → 2128). Si emerge un nuevo concepto técnico, se agrega un patrón al array.

### Caching

- **Backend:** sin cache propio en el endpoint. Reusa el cache mensual de `snapshotCache.ts` (TTL 5min/1h). Caso caliente: ~50-150ms. Caso frío: ~2-3s (3 fetches a IM en paralelo).
- **Frontend:** estado local del componente `ClienteObjetivoCard`. La primera vez que se expande la card se hace el fetch; cerrarla y volverla a abrir no refetchea. No se prewarmea: si el vendedor tiene 80 clientes en su lista, no queremos disparar 80 requests al cargar el tab.

### Front-end (`ClienteObjetivoCard`)

Cambios en `src/components/VendorShell.tsx` (componente `ClienteObjetivoCard`):

1. `canExpand` siempre `true` (hoy solo se expande si tiene info comercial o histórico — ahora siempre puede tener compras).
2. Al expandirse por primera vez, disparar fetch al endpoint nuevo. Estado: `{loading, error, data}`.
3. Dentro del bloque expandido, después de "Histórico":
   - **Sección "Top productos · últimos 3 meses"** con dos sub-listas en grid de 2 columnas (en `min-width:0` por bug pasado de overflow). En mobile angosto se apilan vía CSS (single column < 480px).
     - Columna izquierda: "TOP POR $" — top 5 con `detalle`, importe, "N fact".
     - Columna derecha: "MÁS HABITUAL" — top 5 con `detalle`, "N fact", cantidad total.
   - **Sección "Compras recientes · últimos 3 meses"** con lista plegada:
     - Cada fila: `▸ fecha (dd/mm)  tipo+letra+pto+num  monto`.
     - NCs en color rojo, monto en negativo.
     - Click en la fila expande las líneas del comprobante inline.
     - Botón "Ver todas (N)" al final si hay más de 10 facturas — pasa a mostrar todas las del trimestre.
4. **Empty state:** si `data.facturas.length === 0`, mostrar un solo texto: "Sin compras registradas en los últimos 3 meses." (no se muestran las dos secciones de top).
5. **Loading:** spinner inline pequeño donde irían las secciones.
6. **Error:** texto "No se pudieron cargar las compras." + botón "Reintentar" que refetchea.

CSS nuevo:
- `vs-client-historial-compras` (contenedor general)
- `vs-client-top-productos` con `vs-top-col` x 2
- `vs-client-facturas-list`
- `vs-factura-row` (plegada) + `vs-factura-row.is-open` (con líneas)
- `vs-factura-row--nc` (modificador rojo)

### Mobile

Verificación obligatoria en iPhone 17e (mismo viewport que disparó el fix `7155ce9` de overflow). El grid de 2 columnas usa `grid-template-columns: minmax(0,1fr) minmax(0,1fr)` para no causar el mismo bug.

## Tests

**Backend:**
- Unit del filtro + agregación (mock de cabeceras y items): cliente con FA + NC; verificar signo, exclusión técnica, ranking.
- Integration con cache: dos calls seguidas no disparan re-fetch (verifica que reusa cache).
- Permisos: vendedor pide cliente ajeno → 403; vendedor pide cliente propio → 200; admin pide cualquiera → 200.

**Frontend:**
- Playwright: vendedor abre tab Objetivos, expande una card de cliente con compras, verifica que carga, que ve los dos rankings y la lista de 10 facturas, que el botón "Ver todas" expande, que NCs aparecen con clase distinta.
- Playwright: cliente sin compras → empty state correcto.
- Playwright: viewport iPhone 17e (proyecto `iphone-edge`) → no hay overflow horizontal.

## Rollout

1. Branch `feat/cliente-historial-compras` desde `main`.
2. Implementar endpoint + tests + UI.
3. Smoke local (npm run dev) con datos reales de IM.
4. PR a main, deploy automático en EasyPanel.
5. Validación en producción con un cliente real conocido (verificar que los números cuadran con lo que Mati ve en IM directo).
6. No requiere migración, no requiere variables de entorno nuevas.

## Decisiones confirmadas en review (25/05/26)

1. **Rol repartidor:** NO accede al historial en esta iteración.
2. **Lista de patrones de exclusión:** confirmada como está (`['flete', 'descuento', 'bonif', 'ajuste', 'redondeo', 'percepcion']`). Si al ver datos reales aparece otro concepto técnico, se agrega un patrón antes de mergear.

## Lo que NO hacemos en esta iteración (YAGNI)

- No agregamos toggle 1m/3m/6m. Lo hablamos pero decidimos 3 meses fijo. Si más adelante hace falta, se agrega.
- No agregamos exportable a PDF/Excel. Lo de imprimir ya existe a nivel ranking de vendedor (`PrintAvanceView`); si quieren exportable por cliente, va aparte.
- No agregamos comparación contra meses anteriores ("vs trimestre pasado"). Para una primera versión basta el snapshot trimestral.
- No agregamos alertas tipo "este cliente dejó de comprar Mix Energético". Es buen futuro feature pero requiere lógica de baseline.
