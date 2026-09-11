# Mi reparto: primer incremento de consulta

Estado: diseño y prototipo aislados, sin integración a producción.

Mati aprobó avanzar con la evolución el 11/09/2026 y fijó una prioridad: afianzar el circuito actual, que lleva tres días de uso. El primer incremento nuevo permite al chofer consultar sus viajes, paradas y comprobantes; mantiene separados los hitos de confirmación de entrega y rendición.

## Alcance

- Reutilizar login y rol repartidor; conservar acceso al módulo Recibos existente.
- Mostrar únicamente los viajes asignados al chofer vinculado al usuario autenticado.
- Identificar cada parada por destino de entrega. Un cliente puede tener varios destinos y una parada varios remitos.
- Mostrar dirección, contacto, ventana, indicaciones de descarga y remitos sin modificar documentos.
- Mantener la decisión de asignación y orden en oficina.

## Datos y permisos pendientes de integrar

La relación usuario–chofer debe ser explícita y pertenecer al tenant. No inferirla por nombre, email o código de vendedor. Si falta esa relación, informar “No tenés un chofer asignado” y no abrir la lista general.

La API valida tenant, usuario activo, rol y asignación del viaje en cada lectura. No aceptar chofer_id enviado por el navegador como autorización. Los filtros visibles no constituyen una barrera de seguridad.

Los domicilios fiscales no se copian silenciosamente como destinos confirmados. Un destino sin verificar muestra su condición. La asignación del viaje conserva versión y fecha de actualización para la futura descarga offline.

Una parada no se identifica sólo por cliente: usar un identificador de destino persistente. Tampoco deduplicar remitos por cliente/importe. Las cantidades mantienen unidad original, kilos conocidos y peso incompleto como conceptos distintos.

## Interfaz

El prototipo en prototipos/mi-reparto/index.html muestra datos ficticios:

1. Viaje y responsable.
2. Lista de paradas, con próxima visita y estado.
3. Detalle expandible con instrucciones, remitos y cantidades.
4. Acceso ilustrativo a comprobantes de pago.

Los controles del prototipo no envían datos ni confirman entregas. El pie lo indica y no se conecta a APIs reales.

## Evolución posterior

Entregado completo, parcial o fallido requieren un modelo por renglón e intento. El saldo pendiente conserva su documento original sin duplicar venta ni liquidación. Las evidencias y eventos se sincronizan con identidad única, autorización y control de versión.

Una transferencia cargada mantiene su estado de verificación. Una devolución recibida por depósito y una NC por precio son hechos distintos. No incorporar emisión fiscal ni cierre administrativo dentro del botón del chofer.

GPS requiere una decisión técnica independiente: la cabecera actual de la aplicación deniega geolocation. No ampliar permisos de toda la aplicación para habilitar un prototipo. Evaluar permisos sólo en las pantallas y usos que se integren, con alcance explícito y sin prometer rastreo de fondo desde una PWA.

## Criterios antes de incorporar el incremento

- Jornada representativa del circuito actual verificada y sin incidentes críticos pendientes.
- Lecturas de otro tenant/chofer rechazadas por servidor.
- Destinos diferentes y múltiples remitos conservados.
- Modificación de asignación en oficina reflejada sin mostrar datos viejos bajo otra identidad.
- Errores y ausencia de asignación diferenciados de “sin repartos”.
- Tiempos medidos en un teléfono real; descarga offline no declarada lista hasta implementarla y probarla.

Este incremento no requiere que la oficina vuelva a ejecutar el SQL039–041 ni altera la publicación de esas correcciones. Las futuras migraciones se entregarán por separado cuando exista una implementación revisable.
