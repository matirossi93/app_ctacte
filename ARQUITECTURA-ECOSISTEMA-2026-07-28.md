# Arquitectura y escalabilidad — app_ctacte y ecosistema Semillero

**Fecha:** 2026-07-28 · **Pregunta:** ¿está bien estructurada para seguir escalando? ¿Qué le falta para una estructura "de empresa"? · **Método:** 4 lentes (arquitectura interna, ecosistema/duplicación, operaciones, datos/multi-tenant) con verificación adversarial contra los repos reales. Complementa a `AUDITORIA-APP-2026-07-22.md` (aquella = bugs de código; esta = estructura).

---

## Veredicto

Por dentro, app_ctacte está **mejor estructurada que el 90% de las apps de pyme**: TypeScript estricto, 227 tests con CI que bloquea merges rotos, módulos compartidos nacidos de incidentes reales y documentados con fecha. Esa base NO hay que reescribirla.

Lo que le falta para ser "app de empresa" **no es código: es todo lo que pasa alrededor del código**:

1. **Nadie se entera si se cae** — no hay health check ni alertas; el monitoreo hoy es un vendedor enojado.
2. **Decisiones de plata en un archivo frágil** — intereses perdonados y plazos por cliente viven en un SQLite dentro del container (un Rebuild puede borrarlos) y **Amira los ignora al cobrar por WhatsApp**.
3. **El ecosistema crece por copy-paste** — la mora se calcula de 3 formas que ya dan números distintos; la base compartida de TODO recibe migraciones a mano desde 5 repos sin registro, y su backup es una incógnita **a verificar hoy**.

Nada de esto pide infraestructura cara ni reescrituras: con ~2-3 días de trabajo puntual la operación sube un escalón entero. El multi-tenant ya tiene los cimientos pagados (`tenant_id` en todo desde el día 1) — el aislamiento real se construye cuando llegue el tenant 2, no antes.

## Scorecard

| Dimensión | Nota | En una línea |
|-----------|------|--------------|
| Calidad interna (código, tests, CI) | 🟢 **Sólida** | strict:true, 227 tests, CI bloqueante, módulos con cicatrices documentadas — excepcional para una pyme |
| Arquitectura de la app | 🟡 Aceptable | El supuesto "1 réplica" está bien gestionado pero no escrito; server.ts (1506) y VendorShell (2992) concentran riesgo |
| Ecosistema y código compartido | 🔴 Frágil | 9 logins a IM, 3 moras divergentes, 4 interfaces de usuario contra la misma tabla — todo copy-paste |
| Capa de datos (Supabase compartida) | 🔴 Frágil | Buen modelado, proceso frágil: migraciones a mano contra PROD sin registro ni staging de base |
| Operaciones día-2 | 🔴 Frágil | **La pata más floja y la más barata**: sin health, sin alertas, deploy manual, backup sin verificar |
| Seguridad y auth | 🟡 Aceptable | Postura deliberada en ctacte, pero 4 sistemas de sesión y 2 tablas de usuarios en el ecosistema |
| Preparación SaaS multi-tenant | 🔴 Frágil | Las columnas están pagadas; falta el enforcement (hoy: filtros a mano con service key), no el modelo |

## Brechas principales (verificadas)

1. **🔴 Cero monitoreo/health** — no existe `/api/health`; la raíz devuelve 200 aunque IM/Supabase estén muertos; errores de crons solo a consola. *Fix: ~20 líneas + Uptime Kuma gratis en un VPS Oracle que ya pagás.*
2. **🔴 Backup de Supabase = incógnita** — si el plan es Free, NO hay backup automático de la base que es TODA la empresa. Cero pg_dump en los repos. *Verificar el plan lleva 2 minutos.*
3. **🔴 SQLite en el container con decisiones de plata** — `invoice_overrides` + `client_thresholds` solo en `/app/data/database.sqlite` (VOLUME anónimo, persistencia no garantizada) y **`/api/bot` no las lee**: un interés perdonado se sigue reclamando por WhatsApp. *Verificar Mounts en EasyPanel (2 min) + migrar 2 tablas a Supabase (~2h).*
4. **🔴 Mora calculada 3 veces** — bot: umbral $2000 + plazo VISITA + interés; BI: saldo neto >$100 sin plazo ni interés; dashboard: la tercera. Un cliente puede ser moroso para Amira y estar limpio en el BI. *Requiere TU decisión de cuál es la regla canónica.*
5. **🔴 Cero código compartido** — ni paquete npm, ni workspace: el cliente IM existe ~9 veces en el ecosistema (2 en la MISMA app), constantes de negocio duplicadas con comentarios ya divergentes, 0 tipos generados de Supabase. *Fix a escala: repo `@semillero/shared` instalable por git — NO monorepo.*
6. **🔴 La base compartida sin dueño** — migraciones a mano en el SQL Editor desde 5 repos, 3 convenciones, sin registro (ya hubo un choque real: c69d436); los ALTER de `puede_bi`/`puede_inventario` no están en NINGÚN repo — el esquema de prod no se puede reconstruir. *Fix: staging free de Supabase + dump versionado + TABLAS.md.*
7. **🟡 "Proceso único" no documentado** — mutex/caches/9 crons/SQLite asumen 1 réplica; funciona bien HOY, pero un "Scale: 2" en EasyPanel lo rompe en silencio. *Fix: escribirlo en README/Dockerfile + gate `CRON_ENABLED` (~20 líneas). NO Redis.*
8. **🟡 Deploy con paso manual que ya falló** — y `app_listas` en el MISMO panel tiene auto-deploy andando: es config, no infra. + DEPLOY.md de 15 líneas.
9. **🟡 El contrato con Amira es invisible** — la única integración que habla con clientes reales: sin doc, sin tipo, sin test. *Fix: una tarde.*
10. **🟡 Dos archivos-dios** — server.ts (mora inline, crons, capa de datos) y VendorShell.tsx (5 vistas, 83 useState). *Extraer una costura por sesión, empezando por `mora.ts`. Nunca big-bang.*

## Roadmap

### Fase 1 — Ahora (próximas semanas, casi todo en horas)
| Item | Esfuerzo |
|------|----------|
| Verificar plan/backup de Supabase + cron de pg_dump a VPS Oracle + UNA restauración de prueba | horas |
| Verificar Mounts de `/app/data` en EasyPanel + migrar las 2 tablas de plata a Supabase + que `/api/bot` las lea | horas |
| `/api/health` + GIT_SHA en el build (responde para siempre "¿el Rebuild tomó mi commit?") | horas |
| Uptime Kuma apuntando a las 4-5 apps (gratis, VPS que ya pagás) | horas |
| Auto-deploy (copiar config de app_listas) + DEPLOY.md | horas |
| Contrato "replicas=1" escrito + gate CRON_ENABLED | horas |
| Documentar + testear el contrato con Amira | horas |
| Matar el getIMToken duplicado de server.ts (ya estaba en el plan de la auditoría) | horas |

### Fase 2 — Próximos 3 meses
| Item | Esfuerzo |
|------|----------|
| Unificar mora: extraer `server-lib/mora.ts` con tests (previa decisión de la regla canónica) | días |
| Repo `@semillero/shared`: cliente IM + constantes + tipos generados de Supabase; adopción de a una app | días |
| Dueño de la base: staging Supabase free + dump del esquema versionado + TABLAS.md | días |
| Comparar ventas BI vs tabla sincronizada (1 mes, 2 totales, 1 número) | horas |
| Adelgazar server.ts y VendorShell, una costura por sesión | días |
| README real + capa API del front (oportunista) | días |

### Fase 3 — Cuando el SaaS multi-tenant arranque
| Item | Esfuerzo |
|------|----------|
| Enforcement de aislamiento: FK de tenant_id, decisión deploy-por-tenant vs instancia única, test de humo | semanas |
| Una identidad por usuario (absorber prod_usuarios, verificador compartido — sin SSO) | días |
| Separar worker de web (con CRON_ENABLED ya hecho; mutex pasa a claim en base) | días |
| Sentry free tier + extender el patrón espejo de datos a saldos/ventas | semanas |

## Lo que NO hacer (que nadie te venda humo)

- **Microservicios / gateway de IM como servicio**: un paquete compartido resuelve lo mismo sin infra nueva.
- **Kubernetes**: con 3 VPS y 10 usuarios, es un empleado full-time disfrazado de tecnología.
- **Monorepo Nx/Turborepo**: un repo compartido chico instalable por git, no reestructurar 8 repos que funcionan.
- **Redis/colas**: el gate CRON_ENABLED crea la misma costura gratis.
- **Datadog/Grafana/ELK**: Uptime Kuma + Sentry free cubren el 90% a costo cero.
- **OpenAPI**: para UNA integración (Amira), un doc de una página + un test de shape.
- **SSO/Keycloak**: una tabla de usuarios + un verificador compartido es el mínimo que paga.
- **RLS-por-JWT hoy**: con 1 tenant es sobre-ingeniería; se evalúa cuando el tenant 2 sea real.
- **Staging de aplicaciones**: no paga a 10 usuarios. Staging de la BASE sí — esa es la distinción.
- **Big-bang refactors**: todo oportunista, una costura por vez (tu propia regla anti-Runaway-Refactor).

## Decisiones para Mati

1. **La regla canónica de mora** — ¿la del bot ($2000 + plazo VISITA + interés), la del BI ($100 neto), o una tercera? Sin esto no se puede unificar. Decidila mirando 2-3 casos reales.
2. **Plan de Supabase** — verificar HOY (2 min). Pg_dump propio ya; plan Pro (~USD 25/mes) recién con un tenant SaaS pagando.
3. **¿Matamos el login legacy?** — recomendado sí: ya está deshabilitado en prod, borrarlo elimina una superficie de auth y un uso del SQLite.
4. **Modelo multi-tenant** — deploy-por-tenant para los primeros 2-3 (simple, tu infra lo banca); instancia única con RLS recién con 5+.
5. **¿El BI migra a leer la tabla ventas sincronizada?** — paso 0: comparar un mes. Si los totales ya divergen, migrar; si no, documentar y seguir.

---

*Generado con análisis multi-agente (9 agentes, 4 lentes + verificación adversarial contra los repos). Calibrado a pyme con ~10 usuarios internos y ambición SaaS — se recomendó solo lo que paga su costo a esta escala.*
