# Listas de precios: aclaración y correcciones

Fuente: audio de Matías del 10/09/2026, recibido el 11/09. Una condición por línea suma todas las unidades de sus productos y presentaciones dentro del mismo presupuesto. Flecky y Full Cat forman una sola línea. La promoción general cuenta el surtido del presupuesto completo.

## Reglas verificadas

La migración035 ya habilita L3 desde20unidades y L4 desde30 para Flecky+Fullcat. El catálogo ubica las bolsas Full Cat281/282 en subrubroFlecky. Se verificaron los casos10+10 y15+15, además de separar cantidades por artículo, línea y presupuesto. No se recargó la tabla de reglas ni se cambió la escala comercial.

La suma ahora usa las reglas efectivas de cada artículo: incluye códigos explícitos con el mismo nombre comercial y excluye los espejos minoristas X KG que no pertenecen al control. Los kg de esos espejos no se interpretan como unidades de bolsa.

El audio habla de unidades cerradas. Se pidió aclarar si conserva la excepción previa20kggranel=1bulto y si incluye unidades pequeñas cerradas. Hasta resolverlo no se cambió ese conteo general. El caso20collares que el motor previo trata como1bulto queda pendiente de esa definición, sin ocultarlo ni declarar completo ese ajuste.

## Errores corregidos

- El evento de fin de lectura de un POST normal podía abortar su respuesta de validación. Se usa la desconexión real de la respuesta.
- La oficina cambia lista y cotiza su precio conjuntamente. Los productos agregados también se cotizan por lista; el precio genérico del catálogo no se usa para guardar.
- Mientras falta precio no se muestra un total completo ni se permite guardar. Cotizaciones anteriores no pisan una lista elegida después. El importe manual de distribución mantiene su uso.
- Antes de escribir, el servidor exige la cotización de los artículos nuevos o modificados. Conserva los precios históricos de las filas intactas, incluso con artículos repetidos y precios diferentes.
- La validación usa la identidad completa del borrador. Una cantidad vacía no desplaza los avisos al siguiente producto. La oficina recalcula al editar; no conserva los carteles del presupuesto anterior.

## Avisos

Las oportunidades de mejor precio están agrupadas y desplegables para el vendedor. Vender por encima del mínimo permitido no genera una tarea de revisión en oficina. Los descuentos fuera de condición siguen visibles aunque el renglón tenga una lista más cara.

Los recordatorios repetidos de contado aparecen una sola vez. El cálculo de la promo y las líneas se consulta en un detalle por presupuesto. Se mantienen errores, falta de control, cantidades dudosas, faltantes de stock y resultados de operaciones pendientes de verificar.

## Publicación

Estos cambios no requieren SQL nuevo. La publicación utiliza el esquema041 que Matías ya aplicó. El postchequeo de despliegue puede verificar el origen por HTTPS si el CDN entrega HTML al runner, manteniendo hostname y certificado y dejando un warning explícito sobre la verificación pública.

Validación: pruebas de negocio, HTTP local real con dependencias simuladas, ediciones con productos repetidos y navegador de vendedor/oficina. No se emiten comprobantes reales como pruebas.
