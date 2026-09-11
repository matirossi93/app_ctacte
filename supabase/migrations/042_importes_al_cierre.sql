-- Guarda el importe vigente de cada entrega al cerrar, sin modificar el snapshot original.
-- Reaperturas y nuevos cierres conservan el historial anterior. Ejecutar antes del despliegue.
begin;
alter table hojas_ruta add column if not exists cierres_importes jsonb not null default '[]'::jsonb;
create or replace function cerrar_hoja_con_importes(p_tenant uuid,p_actor uuid,p_datos jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare
 h hojas_ruta; p hojas_ruta_pedidos; e presupuestos_facturados; i jsonb;
 destino uuid; version_esperada bigint; importes jsonb; resultado jsonb; originales jsonb;
begin
 if p_tenant is null or p_actor is null then raise exception 'Falta identidad del cierre'; end if;
 insert into reparto_control values(p_tenant) on conflict do nothing;
 perform 1 from reparto_control where tenant_id=p_tenant for update;
 destino := (p_datos->>'hoja_id')::uuid;
 version_esperada := (p_datos->>'version_esperada')::bigint;
 select * into h from hojas_ruta where id=destino and tenant_id=p_tenant;
 if not found or h.estado<>'abierta' or version_esperada is distinct from h.version then raise exception 'La hoja cambió. Actualizá antes de cerrar'; end if;
 importes:=p_datos->'importes';
 if jsonb_typeof(importes) is distinct from 'array' then raise exception 'Faltan importes verificados'; end if;
 if jsonb_array_length(importes)=0 or jsonb_array_length(importes)<>(select count(*) from hojas_ruta_pedidos where hoja_id=destino)
   or jsonb_array_length(importes)<>(select count(distinct value->>'im_comprobante_id') from jsonb_array_elements(importes)) then
   raise exception 'Los importes no cubren exactamente las entregas de la hoja';
 end if;
 for i in select value from jsonb_array_elements(importes) loop
   select * into p from hojas_ruta_pedidos where hoja_id=destino and im_comprobante_id=i->>'im_comprobante_id';
   if not found then raise exception 'La entrega cambió de hoja'; end if;
   select * into e from presupuestos_facturados where tenant_id=p_tenant and (im_comprobante_id=p.im_comprobante_id or im_remito_id=p.im_comprobante_id);
   if (select count(*) from presupuestos_facturados where tenant_id=p_tenant and (im_comprobante_id=p.im_comprobante_id or im_remito_id=p.im_comprobante_id))>1 then raise exception 'La entrega tiene vínculos ambiguos'; end if;
   if (i->>'cod_cliente')::int is distinct from p.cod_cliente
     or (i->>'cod_empresa')::int is distinct from coalesce(p.cod_empresa,e.cod_empresa)
     or (i->>'im_factura_id') is distinct from coalesce(e.im_factura_id,p.im_factura_id)
     or jsonb_typeof(i->'total') is distinct from 'number' or (i->>'total')::numeric<0 then
     raise exception 'El importe no corresponde a la entrega verificada';
   end if;
 end loop;
 select jsonb_agg(to_jsonb(hp) order by hp.orden,hp.id) into originales from hojas_ruta_pedidos hp where hp.hoja_id=destino;
 -- El RPC existente vuelve a validar ajustes/operaciones pendientes y la versión bajo el mismo lock.
 resultado:=mutar_reparto(p_tenant,p_actor,'hoja_editar',jsonb_build_object('hoja_id',destino,'version_esperada',version_esperada,
   'cambios',coalesce(p_datos->'cambios','{}')||jsonb_build_object('estado','cerrada')));
 update hojas_ruta set cierres_importes=cierres_importes||jsonb_build_array(jsonb_build_object(
   'version',version,'cerrado_at',cerrada_at,'cerrado_por',p_actor,'pedidos',importes,'originales',originales))
   where id=destino and tenant_id=p_tenant returning * into h;
 return to_jsonb(h);
end $$;
revoke all on function cerrar_hoja_con_importes(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function cerrar_hoja_con_importes(uuid,uuid,jsonb) to service_role;
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
  select jsonb_build_object('version',41,'version_cierre',42,'listo',
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
notify pgrst, 'reload schema';

commit;
