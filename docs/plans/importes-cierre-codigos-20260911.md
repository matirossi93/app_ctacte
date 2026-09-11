# Importes vigentes e impresiones — 11/09/2026

La factura editada en InfoManager debe definir el importe del tablero y de las entregas abiertas. Se consulta por rango compartido, con lectura puntual por ID para facturas fuera del rango. Se verifica tipoFA, vigencia, cliente, empresa y total explícito. No se escribe en IM; ante una consulta fallida no se publica el snapshot como importe vigente.

Al cerrar, un RPC guarda los importes verificados y los registros originales en `hojas_ruta.cierres_importes`, bajo el mismo lock de reparto y versión esperada. Las lecturas de hojas cerradas y liquidaciones usan el último cierre. Reabrir vuelve a consultar IM; el siguiente cierre agrega historial. Los cierres anteriores a esta función conservan el comportamiento previo, sin inventar un importe histórico nuevo.

Los PDF de PR/FA/RE/NC/ND y los listados de fraccionado incluyen código de artículo. Fraccionado agrupa por código; dos artículos con la misma descripción siguen separados. Se conserva la capacidad del PDF de42/45renglones por página y el remito sin importes.

## Publicación

Aplicar042_importes_al_cierre.sql antes del despliegue. El diagnóstico SQL conserva version41 para no bloquear la app anterior al aplicar la migración; añade version_cierre42. La versión nueva requiere ambas señales y publica esquema_requerido42 en /readyz.

La migración fue probada dos veces en PostgreSQL17 aislado, junto con todas las migraciones del circuito. Cierre: dos entregas distintas, cobertura exacta, identidad, versión, dos cierres concurrentes con un ganador, original100 preservado, cierre80, reapertura y cierre70 con historial completo. Revisión independiente Astra aprobada.
