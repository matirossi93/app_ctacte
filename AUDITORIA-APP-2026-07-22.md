# Auditoría completa — app_ctacte

**Fecha:** 2026-07-22 · **Alcance:** toda la app (79 endpoints, ~26.500 líneas) · **Método:** 6 lentes especializados (seguridad, plata, robustez, performance, frontend, deuda técnica) con verificación adversarial de cada hallazgo alta/media contra el código crudo. Los hallazgos refutados en verificación fueron descartados y no aparecen acá.

---

## Veredicto general

La app está mejor de lo que su tamaño sugiere: la autenticación cubre bien los endpoints que mueven plata (las dos sospechas iniciales resultaron falsos positivos), los signos contables son consistentes entre módulos, y hay 227 tests con CI real. No se encontró ningún agujero que permita fraude directo ni plata que se esté pagando mal HOY.

Pero hay un bug confirmado que corrompe datos de plata en silencio (montos con centavos ×100), y dos frentes débiles: la robustez cuando InfoManager se cae (token duplicado que repetiría el incidente de julio en modo silencioso) y que el cálculo de comisiones no tiene ni un solo test. Nada está en llamas, pero esas tres cosas merecen atención esta semana.

## Lo que está bien (para calibrar)

- **Auth mejor de lo esperado:** 70/79 endpoints con JWT; todo lo que aprueba/edita recibos, conciliación y comisiones valida rol admin/gerente. Los endpoints `/api/debug` sospechosos SÍ chequean rol (falsos positivos descartados). Un vendedor no puede ver ni tocar datos de otro en los flujos principales.
- **Lógica contable consistente:** signos FA/NC iguales entre comisiones, objetivos y sync; redondeos sistemáticos; la conciliación evita el doble descuento de anticipos.
- **Las cicatrices de incidentes curaron bien:** pre-chequeo anti-duplicado post-HASAN sólido y fail-closed; retry de token IM en infomanager.ts; mensaje "NO lo cargues a mano".
- **227 tests en 1 segundo + CI** que buildea front y server en cada push. Los módulos nacidos de incidentes están blindados.
- **Caches de diseño maduro** (stale-while-revalidate, coalescing, TTLs diferenciados). Los problemas son de configuración y ciclo de vida, no de concepto.
- **Frontend mobile cuidado:** estados de carga/error/vacío casi en todas las vistas, formularios que preservan lo tipeado, safe-areas.
- **Higiene notable:** 1 solo TODO real en 27k líneas, 2 funciones muertas, casi cero código zombie.

---

## Hallazgos principales (verificados)

### 🔴 1. Montos con centavos se graban ×100 al cargar un recibo — ALTA
El celular normaliza el monto a `1500.50` y el servidor lo vuelve a parsear asumiendo formato argentino: borra el punto y graba **150050**. Determinístico para cualquier pago con centavos. Además rompe la verificación MercadoPago de esos recibos (busca un pago de $150.050 que no existe) e infla el "en tránsito" de conciliación. Mitigante: el admin ve la foto al aprobar, y la tolerancia de $5 impide imputar ×100 contra facturas — pero un **anticipo** no tiene ese cross-check.
**Evidencia:** `server-lib/recibos.ts:173` vs `src/components/RecibosApp.tsx:430-442`. Reproducido en node.
**Fix:** una línea (`Number(req.body.monto)` directo) + test de regresión + query de sanidad sobre históricos.

### 🔴 2. Token de IM duplicado en server.ts: /api/data puede quedar roto hasta 23h en silencio — ALTA
Hay DOS caches de token de InfoManager: el bueno (infomanager.ts, con invalidación y retry) y un duplicado viejo en `server.ts:197-216` que **nunca se invalida**. La pantalla principal de cuenta corriente usa el duplicado: si IM mata la sesión (pasó el 06-07/07), el retry renueva el token equivocado. El usuario no ve error — cae al fallback de Google Sheets con datos posiblemente viejos, y en ese camino el filtro por vendedor NO se aplica (el CSV completo viaja por la red).
**Fix:** borrar el duplicado (~20 líneas) y usar `imClient()` de infomanager.ts en los 3 call-sites.

### 🔴 3. Comisiones sin ni un solo test — ALTA
`comisiones.ts` (916 líneas) y `comisionesRules.ts` (la tabla de %: 5% exactos, 1% lista, FLECKY, rubro 11 al 4%, resto 3.5%) no son importados por ningún test. Las reglas cambian de verdad (FLECKY en mayo, 5.5%→5.0%) y un typo cambia la liquidación de TODOS los vendedores en silencio. Bonus: `COMISION_55PCT_CODES` dice 5.5% pero vale 0.05.
**Fix:** ~1h — test de tabla + caso dorado con fixtures (patrón ya existente en el repo).

### 🔴 4. aprobarRecibo (el write-path más peligroso) sin test de flujo — ALTA
Las 270 líneas que graban plata en el ERP no tienen test: la rama anticipo, el pre-chequeo fail-closed, y la clasificación "IM no respondió → NO lo cargues a mano" vs "IM rechazó". Un refactor que pierda el flag `sinRespuesta` reproduce el incidente HASAN del 18/07.
**Fix:** test de flujo con vi.mock (patrón de syncVentas.test.ts): 4 casos.

### 🔴 5. El prewarm castiga a IM: re-descarga 6 meses completos cada 20 min — ALTA
`force:true` en los 6 meses = ~180 requests pesadas contra IM por ciclo, 3× por hora, refetcheando meses con TTL de 24h. Sin lock anti-solapamiento (el perfil del crash-loop del 06/07).
**Evidencia:** `server.ts:1373-1386` + cron `*/20` sin lock.
**Fix:** force solo para el mes actual + lock estilo `prewarmInFlight`. Media hora.

### 🔴 6. No hay forma de cortar una sesión — ALTA (calibrada media por verificación)
El JWT lleva rol adentro y solo se valida firma+expiración; `activo` se mira solo en el login. Desactivar un usuario o bajarle el rol no lo expulsa hasta 8h. Palanca de emergencia que ya existe: rotar `JWT_SECRET` en EasyPanel + redeploy invalida TODO.
**Fix:** columna `token_version` (~medio día). Ver decisión #4.

### 🔴 7. La mora está calculada DOS veces (dashboard vs bot WhatsApp) y ya divergieron — ALTA
Cuatro divergencias: gracia default 15 vs 0 días; el bot no reconoce QUINCENAL; el bot solo cuenta FA (no ND); el bot **ignora los intereses perdonados a mano** — un interés que perdonaste se sigue informando cobrado por WhatsApp. El incidente del 02/07 ya obligó a parchear la misma regla en las dos copias.
**Fix:** extraer `calcularMora()` compartida con tests. Requiere decidir las 4 reglas (decisión #3).

### 🟡 8. Aprobación de recibos sin guards atómicos — MEDIA
(1) Dos admins a la vez pueden emitir DOS recibos en IM (el doble-click de un mismo admin ya está mitigado); (2) se puede rechazar un recibo ya imputado; (3) si IM acepta pero el update final a Supabase falla, el ID del recibo IM se pierde.
**Fix:** claim atómico (`UPDATE ... WHERE status='pendiente_revision'`) + guard en rechazar + persistir ID ante fallo. ~2-3h.

### 🟡 9. La verificación MercadoPago es decorativa — MEDIA
El mismo payment_id puede "respaldar" N comprobantes (foto subida dos veces = ambos verified contra el MISMO pago); editar el monto no resetea la verificación; aprobar no mira el estado MP.
**Fix:** excluir payment_ids usados + reset al editar + warning visual al aprobar. Un par de horas.

### 🟡 10. Caída de IM → Comisiones y Objetivos muestran $0 con cara de dato real — MEDIA
El catch del cache resuelve a lista vacía y los endpoints serios la adoptan: 200 con totales en $0, indistinguible de "no vendiste nada". El patrón correcto (`rebotes_error`) ya existe en el repo.
**Fix:** error honesto / flag `im_down` con mensaje en UI.

### 🟡 11. Alertas de abandono leídas quedan leídas PARA SIEMPRE — MEDIA
El ID `alc-{cod_cliente}` no tiene componente temporal: una recaída futura del mismo cliente nunca vuelve a encender el badge. Socava el rediseño del 22-jul. El read-set de localStorage además nunca se poda.
**Fix:** ID con episodio/detected_at (requiere campo del backend) + poda del set. Encaja con la 2ª tanda de alertas.

### 🟡 12. Caches RAM sin tope + ventanas frías cada 30 min — MEDIA
(a) Cada mes histórico navegado queda en RAM para siempre (~35-55MB/mes, UI permite 12 meses → riesgo OOM); (b) el sync BORRA el mes actual del cache en vez de marcarlo viejo → fetch sincrónico de segundos y campana vacía en esa ventana.
**Fix:** cap de entradas + marcar stale en vez de delete. ~20 líneas.

---

## Plan de mejoras priorizado

| # | Mejora | Esfuerzo | Riesgo |
|---|--------|----------|--------|
| 1 | Fix monto ×100 + test de regresión | Bajo | Bajo |
| 2 | Guards atómicos del flujo de aprobación | Bajo | Bajo |
| 3 | Tests de comisiones + test de flujo aprobarRecibo | Medio | Bajo |
| 4 | Unificar token IM (borrar duplicado de server.ts) | Bajo | Medio |
| 5 | Cerrar endpoints legacy sin control de rol | Bajo | Bajo |
| 6 | Prewarm sin force + lock anti-overlap | Bajo | Bajo |
| 7 | Revocación de sesión (token_version) | Medio | Medio |
| 8 | Unificar cálculo de mora (dashboard vs bot) | Medio | Medio |
| 9 | Endurecer verificación MercadoPago | Bajo | Bajo |
| 10 | Errores honestos en vez de $0 silenciosos | Medio | Bajo |
| 11 | Ciclo de vida de caches (cap + stale) | Bajo | Bajo |
| 12 | Upload robusto + fix alertas leídas | Medio | Bajo |

## Quick wins (<1h cada uno)

1. **Fix monto ×100** (recibos.ts:173) — el más importante de toda la auditoría.
2. `force:true` → solo mes actual en prewarm (server.ts:1373-1386).
3. `requireAdmin` en los 4 endpoints de overrides/client-thresholds (server.ts:970-1010) — hoy cualquier vendedor puede apagar intereses sin rastro.
4. Guard de status en rechazarRecibo (una línea).
5. `/api/notificaciones` al denyRepartidor (server.ts:569).
6. `requireJwt+requireAdmin` en `/api/debug/cache-state` (server.ts:662) — el único endpoint 100% público.
7. Timeout en el cliente OCR (`ocrRecibo.ts:10`).
8. Usar `parseRes` en el submit de UploadRecibo (RecibosApp.tsx:465) — elimina el error críptico en la calle.
9. Borrar `clasificarCabecera` duplicada de comisiones.ts:89 → importar la testeada.
10. Login con `.eq` en vez de `.ilike` (auth.ts:91).
11. Aplicar comisionOverrides en facturasVendedor (comisiones.ts:643).
12. Borrar `hasAnyMPToken` (muerta); decidir `invalidatePendientesCache`.

## Decisiones de negocio (para Mati)

1. **¿El Dashboard viejo con APP_PASSWORD se sigue usando?** Si nadie lo usa → vaciar la variable y borrar el flujo legacy cierra 3 hallazgos de seguridad de un golpe. La mejor relación costo/beneficio de la lista.
2. **¿Fallback a Google Sheets cuando IM se cae, o error honesto?** Si los Sheets no se actualizan más, hoy el fallback sirve saldos viejos sin avisar. Recomendación: error honesto, salvo que los Sheets estén vivos.
3. **Reglas de mora a unificar:** ¿gracia default 0 o 15 días? ¿ND cuenta como deuda vencida? ¿El bot respeta los intereses perdonados a mano? (recomendación: sí, es la fuente de disputas más directa).
4. **¿Cuánto preocupa la ventana de 8h de un token vivo tras desvincular a alguien?** Define si invertir en token_version ahora o dejarlo en backlog.

---

*Generado con auditoría multi-agente (13 agentes, 6 lentes + verificación adversarial). Los hallazgos con severidad calibrada consideran el contexto real: app interna con ~10 usuarios conocidos, no SaaS público.*
