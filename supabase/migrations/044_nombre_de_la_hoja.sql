-- ═══════════════════════════════════════════════════════════════════════════════
-- UN NOMBRE PARA LA HOJA, ADEMÁS DEL NÚMERO
--
-- Mati (14/09/2026): *"necesitamos que se le pueda poner nombre a la hoja además del número,
-- esto es más que nada para poder escribirle la zona para que ayude a identificarla"*.
--
-- 🔑 Es un rótulo escrito a mano, NO la zona de InfoManager. `cod_zona` ya existe y es el código
-- de IM (1=Simoca, 3=Banda…), que queda en NULL cuando la hoja se arma mezclando zonas — que es
-- justo el caso en el que hace falta poder decir "Lules y Famaillá". Por eso es texto libre.
--
-- 🪤 `mutar_reparto` actualiza la hoja con una lista EXPLÍCITA de columnas: sin tocarla, el campo
-- se podría escribir en la tabla pero nunca desde la app. Se reemplaza entera (mismo patrón que
-- la 042 con `reparto_estado_esquema`) y el único cambio respecto de la 040 es agregar
-- `nombre=origen.nombre` al UPDATE de `hoja_editar`.
-- ═══════════════════════════════════════════════════════════════════════════════
begin;

-- Tope de largo: este texto va impreso en la cabecera del papel que sale al camión, y un
-- párrafo entero ahí rompe la hoja en vez de identificarla.
alter table hojas_ruta add column if not exists nombre text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='hojas_ruta_nombre_check') then
    alter table hojas_ruta add constraint hojas_ruta_nombre_check check (nombre is null or length(nombre) <= 60);
  end if;
end $$;

create or replace function mutar_reparto(p_tenant uuid,p_actor uuid,p_accion text,p_datos jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare
  h hojas_ruta; origen hojas_ruta; r retiros_sucursal; a hojas_ruta_ajustes;
  destino uuid; ids text[]; item jsonb; saldo jsonb; anterior hojas_ruta_pedidos;
  fila hojas_ruta_pedidos; detalle jsonb; resultado jsonb := '[]';
  comprobante_id_actual text; ids_del_lote text[] := '{}'; version_esperada bigint; cambiado uuid[] := '{}'; orden_actual integer;
begin
  if p_tenant is null or p_actor is null then raise exception 'Falta identidad de la operación'; end if;
  insert into reparto_control values(p_tenant) on conflict do nothing;
  perform 1 from reparto_control where tenant_id=p_tenant for update;
  destino := nullif(p_datos->>'hoja_id','')::uuid;
  version_esperada := nullif(p_datos->>'version_esperada','')::bigint;
  if destino is not null then
    select * into h from hojas_ruta where id=destino and tenant_id=p_tenant;
    if not found then raise exception 'Hoja no encontrada'; end if;
    if version_esperada is not null and h.version<>version_esperada then raise exception 'La hoja cambió. Actualizá antes de continuar'; end if;
  end if;

  if p_accion='hoja_crear' then
    if nullif(p_datos->>'camion_id','') is not null and not exists(select 1 from hojas_ruta_camiones where id=(p_datos->>'camion_id')::uuid and tenant_id=p_tenant and activo) then raise exception 'Camión inválido'; end if;
    insert into hojas_ruta(tenant_id,numero,fecha,turno,transporte,camion_id,cod_zona,observaciones,created_by)
    values(p_tenant,coalesce(nullif(p_datos->>'numero','')::int,(select greatest(coalesce(max(numero),0)+1,coalesce(nullif(p_datos->>'numero_minimo','')::int,3405)) from hojas_ruta where tenant_id=p_tenant)),
      (p_datos->>'fecha')::date,p_datos->>'turno',p_datos->>'transporte',nullif(p_datos->>'camion_id','')::uuid,
      nullif(p_datos->>'cod_zona','')::int,p_datos->>'observaciones',p_actor) returning * into h;
    return to_jsonb(h);
  elsif p_accion in ('asignar','retiro_marcar') then
    if p_accion='asignar' and (destino is null or version_esperada is null or h.estado<>'abierta') then raise exception 'La hoja no está abierta'; end if;
    if jsonb_typeof(p_datos->'pedidos') is distinct from 'array' or jsonb_array_length(p_datos->'pedidos') not between 1 and 300 then raise exception 'Selección inválida'; end if;
    select coalesce(max(orden),-1) into orden_actual from hojas_ruta_pedidos where hoja_id=destino;
    for item in select value from jsonb_array_elements(p_datos->'pedidos') loop
      comprobante_id_actual:=item->>'im_comprobante_id';
      if comprobante_id_actual is null or comprobante_id_actual!~'^[0-9]+$' or (item->>'cod_empresa')::int is null then raise exception 'Comprobante sin identidad/empresa verificada'; end if;
      ids:=reparto_aliases(p_tenant,comprobante_id_actual);
      if exists(select 1 from presupuestos_facturados where tenant_id=p_tenant and im_remito_id=any(ids) group by im_remito_id having count(*)>1) then raise exception 'La relación presupuesto/remito no es unívoca. Reconciliá antes de asignar'; end if;
      if ids && ids_del_lote then raise exception 'La selección repite la misma entrega'; end if;
      ids_del_lote:=ids_del_lote||ids;
      if (select count(*) from hojas_ruta_pedidos p join hojas_ruta hh on hh.id=p.hoja_id where hh.tenant_id=p_tenant and p.im_comprobante_id=any(ids))>1 then raise exception 'Hay duplicados anteriores de esta entrega. Reconciliá sus destinos'; end if;
      select p.* into anterior from hojas_ruta_pedidos p join hojas_ruta hh on hh.id=p.hoja_id where hh.tenant_id=p_tenant and p.im_comprobante_id=any(ids);
      select * into r from retiros_sucursal where tenant_id=p_tenant and im_comprobante_id=any(ids) limit 1;
      if item->>'tipo_comprobante'='RE' and not exists(select 1 from presupuestos_facturados where tenant_id=p_tenant and im_remito_id=comprobante_id_actual)
        and exists(select 1 from presupuestos_facturados where tenant_id=p_tenant and cod_cliente=(item->>'cod_cliente')::int and cod_empresa=(item->>'cod_empresa')::int
          and im_remito_id is null and (estado_emision in ('remito_emitiendo','incierto') or im_factura_id is not null)) then
        raise exception 'Hay una emisión de este cliente pendiente de identificar. Conciliá el remito antes de asignar';
      end if;
      if p_accion='asignar' and anterior.id is null and p_datos->'origenes'->comprobante_id_actual->>'hoja_id' is not null then raise exception 'El origen cambió: la entrega ya no está en esa hoja'; end if;
      if p_accion='retiro_marcar' then
        if anterior.id is not null then raise exception 'Esta entrega ya está en una hoja'; end if;
        if r.id is not null then
          if r.im_comprobante_id<>comprobante_id_actual then raise exception 'El comprobante gemelo ya está en retiro'; end if;
          resultado:=resultado||to_jsonb(r); continue;
        end if;
        r:=jsonb_populate_record(null::retiros_sucursal,item);
        insert into retiros_sucursal(tenant_id,im_comprobante_id,im_numero,cod_cliente,cliente_nombre,fecha,total,bultos,kg,im_factura_id,im_factura_numero,im_remito_id,im_remito_numero,created_by,cod_empresa,peso_completo,renglones_sin_peso,tipo_comprobante,datos_consultados_at,empresa_fuente,factura_origen)
          values(p_tenant,r.im_comprobante_id,r.im_numero,r.cod_cliente,r.cliente_nombre,r.fecha,r.total,r.bultos,r.kg,r.im_factura_id,r.im_factura_numero,r.im_remito_id,r.im_remito_numero,p_actor,r.cod_empresa,r.peso_completo,r.renglones_sin_peso,r.tipo_comprobante,r.datos_consultados_at,'comprobante_im',r.factura_origen) returning * into r;
        resultado:=resultado||to_jsonb(r);
      else
        if r.id is not null then raise exception 'Esta entrega está en retiro'; end if;
        if anterior.id is not null then
          select * into origen from hojas_ruta where id=anterior.hoja_id and tenant_id=p_tenant;
          if origen.estado<>'abierta' then raise exception 'La hoja de origen no está abierta'; end if;
          if anterior.hoja_id<>destino and ((p_datos->>'mover')::boolean is distinct from true or
            coalesce(p_datos->'origenes'->comprobante_id_actual->>'hoja_id','')<>anterior.hoja_id::text or
            (p_datos->'origenes'->comprobante_id_actual->>'version')::bigint is distinct from origen.version) then raise exception 'El destino cambió o falta autorizar el origen actual'; end if;
          if exists(select 1 from hojas_ruta_ajustes where tenant_id=p_tenant and im_comprobante_id=any(ids)) then
            raise exception 'La entrega tiene ajustes emitidos o pendientes; no se puede reemplazar/mover';
          end if;
          cambiado:=array_append(cambiado,anterior.hoja_id);
          delete from hojas_ruta_pedidos where id=anterior.id and hoja_id=anterior.hoja_id;
        end if;
        fila:=jsonb_populate_record(null::hojas_ruta_pedidos,item); orden_actual:=orden_actual+1;
        insert into hojas_ruta_pedidos(hoja_id,im_comprobante_id,im_numero,cod_cliente,cliente_nombre,pedido_id,orden,saldo_anterior,bultos,kg,total,fecha,im_factura_id,im_factura_numero,im_remito_id,im_remito_numero,facturado_at,cod_empresa,peso_completo,renglones_sin_peso,tipo_comprobante,datos_consultados_at,empresa_fuente,factura_origen)
          values(destino,fila.im_comprobante_id,fila.im_numero,fila.cod_cliente,fila.cliente_nombre,fila.pedido_id,orden_actual,fila.saldo_anterior,fila.bultos,fila.kg,fila.total,fila.fecha,fila.im_factura_id,fila.im_factura_numero,fila.im_remito_id,fila.im_remito_numero,fila.facturado_at,fila.cod_empresa,fila.peso_completo,fila.renglones_sin_peso,fila.tipo_comprobante,fila.datos_consultados_at,'comprobante_im',fila.factura_origen) returning * into fila;
        resultado:=resultado||to_jsonb(fila);
      end if;
    end loop;
    if p_accion='asignar' then
      cambiado:=array_append(cambiado,destino);
      for saldo in select value from jsonb_array_elements(coalesce(p_datos->'saldos','[]')) loop
        insert into hojas_ruta_saldos values(destino,(saldo->>'cod_empresa')::int,(saldo->>'cod_cliente')::int,saldo->'pendientes',(saldo->>'consultado_at')::timestamptz)
          on conflict(hoja_id,cod_empresa,cod_cliente) do update set pendientes=excluded.pendientes,consultado_at=excluded.consultado_at
          where hojas_ruta_saldos.consultado_at<excluded.consultado_at;
      end loop;
    end if;
  elsif p_accion in ('quitar','hoja_borrar','hoja_editar') then
    if destino is null or version_esperada is null then raise exception 'Falta hoja o versión esperada'; end if;
    if p_accion='hoja_editar' then
      detalle:=p_datos->'cambios';
      if h.estado='cerrada' and detalle<>jsonb_build_object('estado','abierta') then raise exception 'Reabrí la hoja antes de modificarla'; end if;
      if detalle->>'estado' in ('cerrada','anulada') and exists(select 1 from hojas_ruta_ajustes where hoja_id=destino and tenant_id=p_tenant and emitido_at is null) then raise exception 'Hay ajustes pendientes o inciertos. No se puede cerrar'; end if;
      if detalle ? 'camion_id' and detalle->>'camion_id' is not null and not exists(select 1 from hojas_ruta_camiones where id=(detalle->>'camion_id')::uuid and tenant_id=p_tenant and activo) then raise exception 'Camión inválido'; end if;
      if detalle ? 'chofer_id' and detalle->>'chofer_id' is not null and not exists(select 1 from choferes where id=(detalle->>'chofer_id')::uuid and tenant_id=p_tenant and activo) then raise exception 'Chofer inválido'; end if;
      origen:=jsonb_populate_record(h,detalle);
      update hojas_ruta set nombre=origen.nombre,fecha=origen.fecha,turno=origen.turno,transporte=origen.transporte,camion_id=origen.camion_id,chofer_id=origen.chofer_id,cod_zona=origen.cod_zona,observaciones=origen.observaciones,estado=origen.estado,
        cerrada_at=case when detalle ? 'estado' then case when origen.estado='cerrada' then now() else null end else h.cerrada_at end,
        cerrada_por=case when detalle ? 'estado' then case when origen.estado='cerrada' then p_actor else null end else h.cerrada_por end
        where id=destino and tenant_id=p_tenant;
    else
      if h.estado<>'abierta' then raise exception 'La hoja no está abierta'; end if;
      ids:=reparto_aliases(p_tenant,p_datos->>'im_comprobante_id');
      if exists(select 1 from hojas_ruta_ajustes where hoja_id=destino and tenant_id=p_tenant and (p_accion='hoja_borrar' or im_comprobante_id=any(ids))) then raise exception 'La entrega tiene ajustes; no se borra'; end if;
      if p_accion='hoja_borrar' then delete from hojas_ruta where id=destino and tenant_id=p_tenant; return jsonb_build_object('ok',true); end if;
      delete from hojas_ruta_pedidos where hoja_id=destino and im_comprobante_id=any(ids);
      if not found then raise exception 'La entrega cambió de hoja'; end if;
    end if;
    cambiado:=array_append(cambiado,destino);
  elsif p_accion in ('retiro_editar','retiro_quitar') then
    select * into r from retiros_sucursal where tenant_id=p_tenant and im_comprobante_id=p_datos->>'im_comprobante_id';
    if not found or version_esperada is distinct from r.version then raise exception 'El retiro cambió. Actualizá'; end if;
    if p_accion='retiro_quitar' then
      if r.retirado_at is not null then raise exception 'El cliente ya retiró esta entrega'; end if;
      delete from retiros_sucursal where id=r.id and tenant_id=p_tenant; return jsonb_build_object('ok',true);
    end if;
    update retiros_sucursal set retirado_at=case when (p_datos->>'retirado')::boolean is distinct from false then now() else null end,version=version+1 where id=r.id and tenant_id=p_tenant returning * into r;
    return to_jsonb(r);
  elsif p_accion in ('ajuste_reclamar','ajuste_vincular','ajuste_finalizar','ajuste_borrar') then
    if p_accion in ('ajuste_finalizar','ajuste_borrar') then
      select * into a from hojas_ruta_ajustes where id=(p_datos->>'id')::uuid and tenant_id=p_tenant;
      if not found then raise exception 'Ajuste no encontrado'; end if;
      select * into h from hojas_ruta where id=a.hoja_id and tenant_id=p_tenant;
      if not found then raise exception 'Hoja no encontrada'; end if;
      destino:=h.id;
    end if;
    if destino is null or h.estado<>'abierta' then raise exception 'La hoja no está abierta'; end if;
    if p_accion in ('ajuste_reclamar','ajuste_vincular','ajuste_borrar') and version_esperada is distinct from h.version then raise exception 'La hoja cambió. Actualizá el ajuste'; end if;
    if p_accion='ajuste_borrar' then
      if a.emitido_at is null or a.estado_operacion in ('emitiendo','incierto') or jsonb_array_length(a.items)>0 then raise exception 'El ajuste emitido o incierto no se puede borrar'; end if;
      delete from hojas_ruta_ajustes where id=a.id and tenant_id=p_tenant;
    elsif p_accion='ajuste_finalizar' then
      if a.claim_token is null or nullif(p_datos->>'claim_token','') is null or a.claim_token is distinct from (p_datos->>'claim_token')::uuid or a.estado_operacion not in ('emitiendo','incierto') then raise exception 'Reclamo de ajuste inválido'; end if;
      if coalesce(p_datos->>'estado_operacion','') not in ('rechazado','incierto','completo') then raise exception 'Estado de resultado inválido'; end if;
      if p_datos->>'estado_operacion'='rechazado' then
        delete from hojas_ruta_ajustes where id=a.id and tenant_id=p_tenant;
      elsif p_datos->>'estado_operacion'='incierto' then
        update hojas_ruta_ajustes set estado_operacion='incierto' where id=a.id;
      else
        if nullif(p_datos->>'im_ajuste_id','') is null then raise exception 'Falta ID de la nota emitida'; end if;
        update hojas_ruta_ajustes set im_ajuste_id=p_datos->>'im_ajuste_id',im_ajuste_numero=(p_datos->>'im_ajuste_numero')::int,im_ajuste_tipo=p_datos->>'im_ajuste_tipo',emitido_at=now(),estado_operacion='completo' where id=a.id returning * into a;
      end if;
    else
      detalle:=p_datos->'ajuste'; ids:=reparto_aliases(p_tenant,detalle->>'im_comprobante_id');
      select * into fila from hojas_ruta_pedidos where hoja_id=destino and im_comprobante_id=any(ids);
      if not found or fila.cod_empresa is null or fila.cod_empresa is distinct from (detalle->>'cod_empresa')::int or fila.cod_cliente is distinct from (detalle->>'cod_cliente')::int then raise exception 'La nota no corresponde a la empresa/cliente de la entrega verificada'; end if;
      if exists(select 1 from hojas_ruta_ajustes where tenant_id=p_tenant and im_comprobante_id=any(ids) and emitido_at is null) then raise exception 'Hay un ajuste pendiente o incierto'; end if;
      if p_accion='ajuste_reclamar' then
        if nullif(detalle->>'claim_token','') is null then raise exception 'Falta token del reclamo'; end if;
        if exists(select 1 from hojas_ruta_ajustes where tenant_id=p_tenant and im_comprobante_id=any(ids) and tipo='nc' and jsonb_array_length(items)=0) then raise exception 'Hay notas vinculadas sin detalle de cantidades; conciliá su detalle antes de emitir otra NC'; end if;
        if jsonb_array_length(coalesce(detalle->'items','[]'))=0 then raise exception 'Faltan renglones'; end if;
        -- Revalidación acumulada bajo el lock: las cantidades del request se consolidan.
        if exists(
          with nuevas as (select (v->>'cod_articulo')::int cod,sum((v->>'cantidad')::numeric) cant from jsonb_array_elements(detalle->'items') v group by 1),
          anteriores as (select (v->>'cod_articulo')::int cod,sum((v->>'cantidad')::numeric) cant from hojas_ruta_ajustes aj cross join lateral jsonb_array_elements(aj.items) v where aj.tenant_id=p_tenant and aj.im_comprobante_id=any(ids) and aj.tipo='nc' group by 1),
          limites as (select (v->>'cod_articulo')::int cod,sum((v->>'cantidad')::numeric) cant from jsonb_array_elements(p_datos->'limites') v group by 1)
          select 1 from nuevas n left join anteriores previas using(cod) left join limites l using(cod) where n.cant<=0 or l.cant is null or n.cant+coalesce(previas.cant,0)>l.cant
        ) then raise exception 'La suma de notas supera lo entregado'; end if;
      elsif nullif(detalle->>'im_ajuste_id','') is null then raise exception 'Falta la identidad de la nota'; end if;
      a:=jsonb_populate_record(null::hojas_ruta_ajustes,detalle);
      insert into hojas_ruta_ajustes(tenant_id,hoja_id,im_comprobante_id,cod_cliente,cliente_nombre,tipo,motivo,importe,items,im_ajuste_id,im_ajuste_numero,im_ajuste_tipo,emitido_at,reclamado_at,created_by,cod_empresa,estado_operacion,claim_token)
        values(p_tenant,destino,fila.im_comprobante_id,a.cod_cliente,a.cliente_nombre,coalesce(a.tipo,'nc'),a.motivo,a.importe,coalesce(a.items,'[]'),a.im_ajuste_id,a.im_ajuste_numero,a.im_ajuste_tipo,
          case when p_accion='ajuste_vincular' then now() end,now(),p_actor,a.cod_empresa,case when p_accion='ajuste_vincular' then 'completo' else 'emitiendo' end,a.claim_token) returning * into a;
    end if;
    resultado:=to_jsonb(a); cambiado:=array_append(cambiado,destino);
  elsif p_accion='saldo_guardar' then
    if destino is null then raise exception 'Falta hoja'; end if;
    for saldo in select value from jsonb_array_elements(p_datos->'saldos') loop
      insert into hojas_ruta_saldos values(destino,(saldo->>'cod_empresa')::int,(saldo->>'cod_cliente')::int,saldo->'pendientes',(saldo->>'consultado_at')::timestamptz)
        on conflict(hoja_id,cod_empresa,cod_cliente) do update set pendientes=excluded.pendientes,consultado_at=excluded.consultado_at where hojas_ruta_saldos.consultado_at<excluded.consultado_at;
    end loop;
    return jsonb_build_object('ok',true);
  else raise exception 'Acción de reparto inválida'; end if;
  update hojas_ruta set version=version+1 where tenant_id=p_tenant and id=any(cambiado);
  if p_accion='hoja_editar' then select * into h from hojas_ruta where id=destino; return to_jsonb(h); end if;
  return jsonb_build_object('ok',true,'filas',resultado,'version',(select version from hojas_ruta where id=destino and tenant_id=p_tenant));
end $$;

revoke all on function mutar_reparto(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function mutar_reparto(uuid,uuid,text,jsonb) to service_role;

create or replace function reparto_estado_esquema() returns jsonb
language sql stable security invoker set search_path=public as $$
  with columnas(tabla,columna) as (values
    ('facturas_correcciones','operacion_id'),
    ('facturas_estado_correccion','im_factura_id'),
    ('facturas_estado_correccion','operacion_id'),
    ('facturas_estado_correccion','originales'),
    ('facturas_estado_correccion','renglones'),
    ('facturas_estado_correccion','tenant_id'),
    ('facturas_estado_correccion','version'),
    ('facturas_operaciones','clase'),
    ('facturas_operaciones','componentes'),
    ('facturas_operaciones','creado_por'),
    ('facturas_operaciones','created_at'),
    ('facturas_operaciones','error'),
    ('facturas_operaciones','estado'),
    ('facturas_operaciones','finales'),
    ('facturas_operaciones','id'),
    ('facturas_operaciones','im_factura_id'),
    ('facturas_operaciones','indice'),
    ('facturas_operaciones','peticion'),
    ('facturas_operaciones','resultados'),
    ('facturas_operaciones','resultado_por_conciliar'),
    ('facturas_operaciones','tenant_id'),
    ('facturas_operaciones','token'),
    ('facturas_operaciones','updated_at'),
    ('hojas_ruta','version'),
    ('hojas_ruta','cierres_importes'),
    ('hojas_ruta_ajustes','claim_token'),
    ('hojas_ruta_ajustes','cod_empresa'),
    ('hojas_ruta_ajustes','estado_operacion'),
    ('hojas_ruta_pedidos','cod_empresa'),
    ('hojas_ruta_pedidos','datos_consultados_at'),
    ('hojas_ruta_pedidos','empresa_fuente'),
    ('hojas_ruta_pedidos','factura_origen'),
    ('hojas_ruta_pedidos','peso_completo'),
    ('hojas_ruta_pedidos','renglones_sin_peso'),
    ('hojas_ruta_pedidos','tipo_comprobante'),
    ('hojas_ruta_saldos','cod_cliente'),
    ('hojas_ruta_saldos','cod_empresa'),
    ('hojas_ruta_saldos','consultado_at'),
    ('hojas_ruta_saldos','hoja_id'),
    ('hojas_ruta_saldos','pendientes'),
    ('presupuestos_control','actividad'),
    ('presupuestos_control','im_comprobante_id'),
    ('presupuestos_control','tenant_id'),
    ('presupuestos_control','token'),
    ('presupuestos_control','updated_at'),
    ('presupuestos_facturados','claim_token'),
    ('presupuestos_facturados','estado_emision'),
    ('presupuestos_facturados','historial_remitos'),
    ('presupuestos_revision','huella'),
    ('reparto_control','tenant_id'),
    ('retiros_sucursal','cod_empresa'),
    ('retiros_sucursal','datos_consultados_at'),
    ('retiros_sucursal','empresa_fuente'),
    ('retiros_sucursal','factura_origen'),
    ('retiros_sucursal','peso_completo'),
    ('retiros_sucursal','renglones_sin_peso'),
    ('retiros_sucursal','tipo_comprobante'),
    ('retiros_sucursal','version')
  ), funciones(firma) as (values
    ('cerrar_hoja_con_importes(uuid,uuid,jsonb)'),
    ('iniciar_operacion_factura(uuid,uuid,text,bigint,text,jsonb,jsonb,jsonb,jsonb,uuid)'),
    ('tomar_paso_factura(uuid,uuid,integer,uuid)'),
    ('terminar_paso_factura(uuid,uuid,uuid,jsonb,text,boolean)'),
    ('cancelar_operacion_factura(uuid,uuid)'),
    ('reclamar_presupuesto(uuid,text,uuid,text)'),
    ('soltar_presupuesto(uuid,text,uuid)'), ('tomar_remito(uuid,text,uuid)'),
    ('reparto_aliases(uuid,text)'), ('mutar_reparto(uuid,uuid,text,jsonb)'),
    ('facturas_de_entrega(uuid,text)'), ('ajuste_entrega_sin_conciliar(uuid,text,integer,integer)'),
    ('controlar_correccion_entrega()'), ('controlar_vinculo_correccion()'), ('controlar_checkpoint_vinculo()')
  ), disparadores(tabla,nombre,funcion,columnas_update) as (values
    ('facturas_operaciones','integridad_correccion_entrega','controlar_correccion_entrega()',array['estado']),
    ('hojas_ruta_ajustes','integridad_vinculo_correccion','controlar_vinculo_correccion()',array['im_ajuste_id','im_comprobante_id','tipo']),
    ('facturas_correcciones','integridad_checkpoint_vinculo','controlar_checkpoint_vinculo()',array['im_comprobante_id','im_factura_id'])
  ), tablas_rls(nombre,permisos) as (values
    ('facturas_estado_correccion',array['SELECT','INSERT','UPDATE']),
    ('facturas_operaciones',array['SELECT','INSERT','UPDATE']),
    ('facturas_correcciones',array['SELECT','INSERT']),
    ('presupuestos_control',array['SELECT','INSERT','UPDATE']),
    ('presupuestos_revision',array['SELECT','INSERT','UPDATE','DELETE']),
    ('presupuestos_facturados',array['SELECT','INSERT','UPDATE','DELETE']),
    ('hojas_ruta',array['SELECT','INSERT','UPDATE','DELETE']),
    ('hojas_ruta_pedidos',array['SELECT','INSERT','UPDATE','DELETE']),
    ('hojas_ruta_ajustes',array['SELECT','INSERT','UPDATE','DELETE']),
    ('retiros_sucursal',array['SELECT','INSERT','UPDATE','DELETE']),
    ('hojas_ruta_saldos',array['SELECT','INSERT','UPDATE']),
    ('reparto_control',array['SELECT','INSERT','UPDATE']),
    ('hojas_ruta_camiones',array['SELECT']), ('choferes',array['SELECT'])
  )
  select jsonb_build_object('version',41,'version_cierre',42,'version_vinculo',43,'version_nombre',44,'nombre_listo',(
      -- La columna Y que `mutar_reparto` la escriba: con la columna sola, el campo existiría en
      -- la tabla y la app no podría guardarlo nunca. Lo que se busca en el cuerpo es la
      -- asignación que hace el trabajo, no un comentario que diga que está.
      select coalesce(exists(select 1 from information_schema.columns c
        where c.table_schema='public' and c.table_name='hojas_ruta' and c.column_name='nombre')
        and pg_get_functiondef(to_regprocedure('public.mutar_reparto(uuid,uuid,text,jsonb)')) like '%nombre=origen.nombre%'
      ,false)
    ),'vinculo_listo',(
      -- Existencia Y permisos efectivos de la función nueva: un comentario o una subcadena los
      -- puede escribir cualquiera, un GRANT no. Y que el disparador la invoque de verdad, para
      -- que reaplicar la migración vieja encima no deje la capacidad diciendo que sí.
      select coalesce(has_function_privilege('service_role',to_regprocedure('public.controlar_vinculo_nota(uuid,text,integer,integer,text,text)'),'EXECUTE')
        and not has_function_privilege('anon',to_regprocedure('public.controlar_vinculo_nota(uuid,text,integer,integer,text,text)'),'EXECUTE')
        and not has_function_privilege('authenticated',to_regprocedure('public.controlar_vinculo_nota(uuid,text,integer,integer,text,text)'),'EXECUTE')
        and pg_get_functiondef(to_regprocedure('public.controlar_vinculo_correccion()')) like '%controlar_vinculo_nota(%'
        and has_function_privilege('service_role',to_regprocedure('public.vincular_nota_existente(uuid,uuid,uuid,bigint,jsonb,text)'),'EXECUTE')
        and not has_function_privilege('anon',to_regprocedure('public.vincular_nota_existente(uuid,uuid,uuid,bigint,jsonb,text)'),'EXECUTE')
        and not has_function_privilege('authenticated',to_regprocedure('public.vincular_nota_existente(uuid,uuid,uuid,bigint,jsonb,text)'),'EXECUTE')
      ,false)
    ),'listo',
    (select bool_and(exists(select 1 from information_schema.columns c
      where c.table_schema='public' and c.table_name=columnas.tabla and c.column_name=columnas.columna)) from columnas)
    and (select bool_and(coalesce(to_regprocedure(firma) is not null
      and has_function_privilege('service_role',to_regprocedure(firma),'EXECUTE')
      and not has_function_privilege('anon',to_regprocedure(firma),'EXECUTE')
      and not has_function_privilege('authenticated',to_regprocedure(firma),'EXECUTE'),false)) from funciones)
    and (select bool_and(exists(select 1 from pg_trigger t where t.tgrelid=to_regclass('public.'||tabla)
      and t.tgname=nombre and t.tgfoid=to_regprocedure(funcion) and not t.tgisinternal and t.tgenabled in('O','A')
      and t.tgtype=23 and t.tgqual is null and not t.tgdeferrable
      and array(select a.attname::text from pg_attribute a where a.attrelid=t.tgrelid and a.attnum=any(t.tgattr) order by a.attname)=columnas_update)) from disparadores)
    and (select bool_and(coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.'||nombre)),false)
      and (select bool_and(coalesce(has_table_privilege('service_role',to_regclass('public.'||nombre),permiso),false)) from unnest(permisos) permiso)) from tablas_rls)
  )
$$;
revoke all on function reparto_estado_esquema() from public,anon,authenticated;
grant execute on function reparto_estado_esquema() to service_role;
commit;
notify pgrst, 'reload schema';
