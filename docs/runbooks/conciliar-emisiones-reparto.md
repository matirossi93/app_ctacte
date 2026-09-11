# Operaciones de reparto: despliegue y conciliación

Las migraciones 039, 040 y 041 (`supabase/migrations/`) deben aplicarse **antes** del servidor y el frontend nuevos. Son idempotentes e incluyen recarga del esquema de PostgREST. Las RPC sólo admiten `service_role`; nunca exponer esa clave al navegador. Si falta esquema/RPC, la aplicación responde 503 y no debe habilitarse un fallback. Mantener el flag de notas en su valor operativo actual: este cambio no autoriza habilitar NC/ND.

## Contratos y límites

- Un PR se aprueba/edita con `huella` SHA256 leída del servidor. La emisión vuelve a verificar la huella aprobada contra IM; una edición elimina previamente la aprobación. Los locks compartidos de `presupuestos_control` impiden editar y emitir simultáneamente desde esta aplicación. No bloquean modificaciones realizadas directamente en IM.
- `GET /api/facturacion/corregir/:idFactura` devuelve renglones efectivos, `version`, `bloqueo_productos` y `operacion`. Para NC/ND, `operacion_id` UUID identifica la intención y debe conservarse junto al cuerpo original, incluida su versión, durante un reintento. Un UUID con otros datos se rechaza.
- Una corrección de productos compara el objetivo contra el último estado confirmado. Cada NC/ND queda registrada antes de pasar a la siguiente. La corrección financiera incrementa versión pero no cambia cantidades. Nunca sumar indiscriminadamente notas financieras al precio del remito.
- Una respuesta perdida conserva `emitiendo`/`incierto` durable. **No hay vencimiento automático**. Retomar desde la UI sólo emite pasos `listo`, nunca vuelve a emitir pasos confirmados. Puede cancelarse únicamente un rechazo explícito del primer paso, sin notas emitidas; queda el rastro `cancelado`.
- `IM_MAX_ADELANTO_FACTURA_DIAS` admite 0–31 (por defecto 7). La fecha máxima se muestra en la previa y el servidor la valida. La búsqueda de duplicados se hace una vez por tanda, fresca, hasta la mayor fecha entre el límite permitido, la fecha solicitada y los PR. La búsqueda por similitud no garantiza detectar documentos externos fuera de la ventana ni equivale a una clave idempotente del proveedor.
- Las notas anteriores sin journal no permiten deducir cantidades efectivas; la corrección de productos se bloquea. No insertar una versión cero inventada para desbloquearlas.

## Antes de cualquier conciliación

Debe intervenir un operador autorizado con acceso a IM y a SQL administrativo. No son acciones automáticas de la aplicación.

1. Detener las emisiones de la aplicación y esperar a que termine o se interrumpa el proceso que poseía el lock. Un timeout del navegador no demuestra que el servidor o IM terminaron. Confirmar con el proveedor si pudo quedar una solicitud pendiente.
2. Guardar en el ticket de incidente una copia de las filas afectadas, tenant, usuario operador, hora, petición, componente/índice, token y evidencia de IM. No copiar credenciales. Conservar comprobantes y vínculos existentes.
3. Buscar por identificadores exactos. Las notas nuevas llevan `[OP:<uuid>:NC]` o `[OP:<uuid>:ND]` además de `[FA:<id>]` en observaciones. Verificar empresa, cliente, tipo/letra, factura asociada, estado vigente, renglones, descuento y total contra `componentes[indice].datos`. Cliente+importe o un número sin empresa/talonario no bastan. Si hay más de una coincidencia o discrepancias, mantener el bloqueo y resolver primero con IM.
4. La ausencia en una consulta temporal o en la caché **no prueba no emisión**. Para declarar no emitido se necesita rechazo definitivo verificable o conciliación completa del proveedor, incluyendo trabajos pendientes. Si no se puede demostrar, mantener `incierto`.

## NC/ND: registrar el resultado comprobado

Primero inspeccionar `facturas_estado_correccion`, `facturas_operaciones` y los vínculos `facturas_correcciones` del mismo tenant/factura. Si el paso ya tiene checkpoint, no registrarlo otra vez. Si la operación está `completo`, no modificarla. No insertar el vínculo manualmente: la RPC lo inserta junto al avance de versión y estado.

Con las condiciones anteriores satisfechas, ejecutar una transacción administrativa. Este es un **modelo que requiere sustituir valores y revisar la evidencia**; no ejecutarlo literalmente:

```sql
begin;
-- Orden obligatorio compartido con 040/041: tenant antes de factura/operación.
insert into reparto_control(tenant_id) values(:'tenant') on conflict do nothing;
select 1 from reparto_control where tenant_id=:'tenant' for update;
-- Usar siempre el tenant de la fila, nunca asumir un tenant global.
select * from facturas_estado_correccion
 where tenant_id = :'tenant' and im_factura_id = :'factura' for update;
select * from facturas_operaciones
 where tenant_id = :'tenant' and id = :'operacion' for update;
-- Comprobar índice, ausencia de checkpoint y estado incierto/emitiendo.
-- Reemplazar token sólo una vez que el ejecutor anterior no puede continuar.
update facturas_operaciones
 set estado='emitiendo', token=:'token_conciliacion', updated_at=now()
 where tenant_id=:'tenant' and id=:'operacion'
   and estado in ('incierto','emitiendo') and indice=:'indice_esperado';
-- EXIGIR exactamente una fila modificada; si no, ROLLBACK y releer.
select terminar_paso_factura(
 :'tenant', :'operacion', :'token_conciliacion',
 :'resultado_verificado'::jsonb, null, false);
-- resultado_verificado: {"id":"ID_IM","numero":123,"tipo":"NC B","total":200}
commit;
```

El `tipo`, número, total e ID deben ser los verificados, no un documento parecido. Guardar el resultado de la RPC y evidencia junto al ticket. Si queda otro componente `listo`, reabrir y retomar la misma operación desde la aplicación; sólo se emitirá el restante.

Si está demostrado que el paso **no se emitió**, usar la misma transacción/lock/índice, llamar a `terminar_paso_factura` con `p_resultado=null`, `p_incierto=false` y `p_error='Conciliado por OPERADOR, ticket REFERENCIA: rechazo/no emisión comprobados ...'`. Eso vuelve el paso a `listo`. Si índice cero y sin resultados puede cancelarse desde la UI, conservando rastro. Nunca convertir una emisión dudosa en rechazo para liberar el sistema.

## Factura o remito inciertos

Consultar `presupuestos_facturados` por tenant y PR. Nunca borrar un claim por antigüedad.

- Factura comprobada: registrar ID/número/tipo de FA, total verificado y pasar a `remito_pendiente`. Conservar los datos originales del PR. Si también existe RE, verificar que corresponde a esa FA y registrar ID/número del RE y `facturado_at`, estado `completo`. Hacer un `UPDATE` con tenant, PR, estado y `claim_token` observado, dentro de transacción y exigiendo una fila; guardar antes/después en el ticket. Nunca pisar un ID ya conocido que difiere.
- Remito comprobado: conservar la FA, registrar RE e importe derivado de sus renglones y pasar a `completo` con `facturado_at`. Antes verificar que no hay otro RE vigente para la misma FA.
- Remito definitivamente no emitido: con FA identificada y vigente, pasar a `remito_pendiente` mediante CAS del token/estado observado. La aplicación podrá reclamar y emitir sólo RE.
- Factura definitivamente no emitida y sin RE: registrar evidencia; pasar a `rechazado` conservando la fila. El endpoint de liberación sólo permite eliminar un rechazo sin FA ni cierre y después el PR debe revisarse de nuevo. No aplicarlo a legacy sin estado ni a filas con comprobantes.
- FA anulada: estado `anulado` conserva IDs y queda bloqueado. Una FA anulada con RE vigente requiere resolver explícitamente el movimiento de stock en IM. No generar automáticamente otra pareja FA/RE.
- RE anulado: la sincronización conserva su ID/número en `historial_remitos`, conserva la FA y permite reclamar un nuevo RE. Revisar ese historial al conciliar para no confundir el anterior con el vigente.

## Edición de presupuesto incierta

`presupuestos_control` conserva el token ante una escritura desconocida o una recreación incompleta. No hacer `DELETE` ni poner token en null a ciegas. Leer el PR original, el nuevo PR si lo hubo y las referencias locales a pedidos. Confirmar cantidades/precios/observaciones/fecha y cuál quedó vigente. Ante recreación, verificar que exista un único PR válido que represente el pedido y reconciliar las referencias locales; el nuevo ID se devuelve si se conoce, pero una caída antes de recibirlo exige investigación en IM. No hay journal completo de cada paso de recreación de PR.

Después de detener el ejecutor anterior y documentar la conciliación, eliminar cualquier aprobación anterior y ejecutar `soltar_presupuesto(tenant, id_pr, token_observado)`, exigiendo `true`. Reabrir el detalle y aprobar su nueva huella. No liberar una operación cuyo resultado siga sin conocerse.

## Verificación de despliegue

Aplicar 039–041 y verificar funciones, RLS/grants y PostgREST antes de habilitar escrituras. Ejecutar pruebas offline de journal/CAS y probar las pantallas con API simulada. Las pruebas no demuestran que IM acepte todos los contratos de éxito ni validan sus efectos fiscales/stock: una respuesta desconocida falla cerrada. La compatibilidad operativa de respuestas del proveedor debe verificarse con evidencias autorizadas; no emitir documentos de prueba reales ni cambiar el flag NC para probar este despliegue.

## Escritores del vendedor y notas de entrega (041)

El vendedor comparte locks del pedido estable (`pedido:<uuid>`) y de los IDs PR anterior/nuevo con el panel. Conciliar sus tokens y referencias locales juntos; no liberar sólo el PR viejo dejando el pedido estable bloqueado, ni liberar el pedido antes de verificar los documentos. La ausencia del reemplazo en una lectura ya no devuelve automáticamente el pedido a enviado.

La emisión alternativa de NC de entrega fue retirada; ningún valor de IM_NC_EMISION_HABILITADA la reactiva. Las notas reales se vinculan a una factura unívoca; una NC del journal no puede vincularse a otra factura. Una nota de entrega externa sin cantidades conciliadas bloquea nuevas correcciones de productos. Los ajustes legacy sin factura identificable bloquean conservadoramente para ese cliente/empresa; resolver la asociación, no borrar el ajuste para eludir el guard. Las notas financieras independientes mantienen su semántica.

Toda conciliación que toca journal o vínculos toma reparto_control del tenant antes de factura/operación/hoja. No invertir ese orden mediante SQL manual.

Si el proveedor confirmó una nota pero el checkpoint detectó un vínculo contradictorio, la operación permanece emitiendo y `resultado_por_conciliar` conserva ID/número/tipo/total bajo CAS. Resolver primero la asociación incorrecta; después registrar ese resultado exacto mediante terminar_paso_factura. No repetir el POST. Si la base también estaba inaccesible, la respuesta/log identifica el comprobante para investigación; no se presume persistencia del campo.


## Publicación de esta versión (039–041)

La rama de correcciones se revisa antes de pasar a main. No avanzar main durante un despliegue: el webhook actual reconstruye la rama y no recibe un SHA inmutable. CI conserva en curso las ejecuciones de main, dispara un único POST y comprueba la identidad de la aplicación publicada. Un workflow fallido **no ejecuta rollback automático**.

1. Con la rama definitiva y su lockfile, ejecutar `npm ci`, ambas builds, `npm test`, `npm run test:reparto:db` y `npm run test:reparto:browser`. Las pruebas SQL crean PostgreSQL aislado, con datos ficticios; las del navegador bloquean servicios externos. Construir la imagen y ejecutar `python3 tests/reparto/docker-smoke.py IMAGEN HASH`. `npm audit --omit=dev` debe pasar. Guardar logs y el hash calculado por `node scripts/build-info.mjs`.
2. Generar el SQL definitivo mediante `node scripts/preparar-migracion-reparto.mjs . > migracion-reparto.sql`. El archivo incluye 039, 040 y 041 en una sola transacción, límites de espera por locks y comprobación final. Respaldar previamente la base Supabase mediante el procedimiento operativo del proyecto. Ejecutar el archivo íntegro con acceso administrativo al proyecto correcto; la clave service_role de la aplicación no permite DDL. Exigir COMMIT y resultado `{"version":41,"listo":true}` de `select public.reparto_estado_esquema();`. Si hay timeout/error, investigar y reejecutar la transacción completa: nunca publicar ignorando el fallo. Verificar también la RPC a través de PostgREST para comprobar recarga y permisos.
3. Antes del primer arranque como UID/GID1000, preparar el volumen persistente. Identificar el contenedor y el volumen del servicio `lista_precios_cta_cte`, sin cambiar otros servicios. Realizar un respaldo **consistente** de SQLite con la API backup de SQLite o `VACUUM INTO` usando el `node:sqlite` de la imagen actual; no copiar sólo `database.sqlite` mientras haya escrituras o WAL. Guardar la copia fuera del contenedor/volumen, con acceso restringido, checksum e `integrity_check`. Conservar también `uploads-tmp` si contiene trabajo pendiente. Durante la preparación final, detener/drenar escrituras y jobs del proceso anterior.
4. Inspeccionar dueño/modo de `/app/data`, `database.sqlite`, los archivos WAL/SHM existentes y `uploads-tmp` con sus archivos. Los volúmenes existentes conservan sus permisos aunque el Dockerfile haga chown. Corregir **sólo esos datos del servicio** a UID/GID1000; no usar chmod777 ni cambios recursivos en rutas del host sin verificar el volumen. Confirmar como UID1000 que puede abrir la base, crear/eliminar un archivo temporal propio en el directorio y escribir en uploads-tmp. No eliminar WAL/SHM a mano. Si la preparación falla, mantener la versión anterior detenida o recuperar el acceso anterior antes de reabrirla.
5. Con SQL y volumen verificados, integrar main una sola vez. CI llama al webhook; no duplicarlo manualmente. El arranque conserva el prewarm configurado y puede tardar varios minutos. Para verificar, usar `/healthz`, `/readyz`, el contenedor y logs acotados; no disparar búsquedas masivas ni emisiones reales en IM. `/healthz` acredita vida del proceso; sólo `/readyz` con HTTP200, `listo:true`, `esquema_listo:true`, `esquema_requerido:41` y el **hash esperado** acredita la publicación. Un HTTP200 del HTML del SPA no es esta verificación. Confirmar el frontend servido y una navegación sin escrituras.
6. Guardar identidad de la imagen anterior y nueva, respaldo, resultado SQL y resultado del postcheck. El gate conserva brevemente (30s) una lectura de esquema exitosa; no usarlo como bloqueo administrativo instantáneo. Si hace falta parar operaciones, detener el servicio o aplicar un bloqueo externo antes de actuar sobre la base.

## Recuperación ante un despliegue fallido

- Si falla el SQL, la transacción no deja una instalación parcial; mantener la aplicación anterior y resolver el error. Conservar el SQL y sus hashes para reproducirlo. Si aparece un error después de COMMIT, comprobar el esquema real antes de decidir reejecutar.
- Si falla el arranque por permisos, detener el despliegue, comprobar el volumen identificado y corregir únicamente sus permisos. El smoke con tmpfs prueba la imagen, no los permisos de un volumen histórico.
- Una vez habilitada la versión nueva, conservar journals, claims, resultados por conciliar y vínculos. La imagen anterior **ignora esos bloqueos**: no volver a abrir escrituras con ella. Preferir una imagen compatible que corrija el fallo. Si es imprescindible inspeccionar/recuperar una imagen anterior, detener el servicio desde EasyPanel/Swarm o bloquear desde el proxy todas las escrituras de `/api/presupuestos`, `/api/facturacion`, `/api/hojas-ruta`, `/api/retiros` y `/api/pedidos`, y detener/drenar también los jobs o reconciliadores que escriben. El middleware de la imagen nueva no protege una imagen antigua.
- No restaurar una copia antigua de Supabase/SQLite sobre emisiones que pudieron llegar a IM. Primero detener ejecutores, preservar las filas nuevas y conciliar cada resultado incierto según este runbook. Reabrir sólo con un ejecutor compatible y evidencia de integridad. No liberar tokens por tiempo transcurrido.
