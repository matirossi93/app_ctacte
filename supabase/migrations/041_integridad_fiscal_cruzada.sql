alter table facturas_operaciones add column if not exists resultado_por_conciliar jsonb;
-- NC de entrega y corrección de productos comparten exclusión. No hay segundo emisor.
create or replace function facturas_de_entrega(p_tenant uuid,p_entrega text)
returns table(factura text) language sql volatile security invoker set search_path=public as $$
  select pf.im_factura_id from presupuestos_facturados pf
   where pf.tenant_id=p_tenant and p_entrega in(pf.im_comprobante_id,pf.im_remito_id,pf.im_factura_id)
     and pf.im_factura_id is not null
  union
  select hp.im_factura_id from hojas_ruta_pedidos hp join hojas_ruta h on h.id=hp.hoja_id
   where h.tenant_id=p_tenant and p_entrega in(hp.im_comprobante_id,hp.im_remito_id,hp.im_factura_id)
     and hp.im_factura_id is not null
$$;
create or replace function ajuste_entrega_sin_conciliar(p_tenant uuid,p_factura text,p_cliente integer,p_empresa integer)
returns boolean language sql volatile security invoker set search_path=public as $$
 select exists(
  select 1 from hojas_ruta_ajustes a
   where a.tenant_id=p_tenant and a.tipo='nc'
    and (exists(select 1 from facturas_de_entrega(p_tenant,a.im_comprobante_id) f where f.factura=p_factura)
      or (a.cod_cliente=p_cliente and (a.cod_empresa=p_empresa or a.cod_empresa is null)
          and not exists(select 1 from facturas_de_entrega(p_tenant,a.im_comprobante_id))))
    -- Una NC del journal ya tiene semántica y estado; no se vuelve a descontar por vincularla.
    and not exists(select 1 from facturas_correcciones c where c.tenant_id=p_tenant
      and c.im_factura_id=p_factura and c.im_comprobante_id=a.im_ajuste_id and c.operacion_id is not null)
 )
$$;
create or replace function controlar_correccion_entrega() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
 if new.clase='productos' and (tg_op='INSERT' or new.estado='emitiendo') then
  insert into reparto_control(tenant_id) values(new.tenant_id) on conflict do nothing;
  perform 1 from reparto_control where tenant_id=new.tenant_id for update;
  if nullif(new.peticion->'origen'->>'cliente','') is null or nullif(new.peticion->'origen'->>'empresa','') is null then
   raise exception 'Falta identidad fiscal de origen para corregir productos. Conciliá la operación';
  end if;
  if ajuste_entrega_sin_conciliar(new.tenant_id,new.im_factura_id,
      (new.peticion->'origen'->>'cliente')::int,(new.peticion->'origen'->>'empresa')::int) then
   raise exception 'Hay notas de entrega sin cantidades reconciliadas para esta factura/cliente. Conciliá antes de corregir productos';
  end if;
 end if;
 return new;
end $$;
drop trigger if exists integridad_correccion_entrega on facturas_operaciones;
create trigger integridad_correccion_entrega before insert or update of estado on facturas_operaciones
 for each row execute function controlar_correccion_entrega();
create or replace function controlar_vinculo_correccion() returns trigger
language plpgsql security invoker set search_path=public as $$
declare fa text; cantidad integer;
begin
 if new.tipo<>'nc' then return new; end if;
 insert into reparto_control(tenant_id) values(new.tenant_id) on conflict do nothing;
 perform 1 from reparto_control where tenant_id=new.tenant_id for update;
 select count(*),min(factura) into cantidad,fa from facturas_de_entrega(new.tenant_id,new.im_comprobante_id);
 if cantidad<>1 then raise exception 'La entrega no tiene una factura unívoca. Conciliá el vínculo antes de asociar la NC'; end if;
 if exists(select 1 from facturas_operaciones o cross join lateral jsonb_array_elements(o.componentes) c
    where o.tenant_id=new.tenant_id and o.im_factura_id<>fa and o.estado not in('completo','cancelado')
      and c->>'tipo'='NC' and (c->'datos'->>'cod_cliente')::int=new.cod_cliente
      and (c->'datos'->>'cod_empresa')::int=new.cod_empresa) then
  raise exception 'Hay una NC pendiente de otra factura del mismo cliente/empresa. Conciliá antes de vincular';
 end if;
 if exists(select 1 from facturas_correcciones c where c.tenant_id=new.tenant_id
    and c.im_comprobante_id=new.im_ajuste_id and c.im_factura_id<>fa) then
  raise exception 'La NC ya corresponde a otra factura. No se puede vincular a esta entrega';
 end if;
 if exists(select 1 from facturas_operaciones o where o.tenant_id=new.tenant_id and o.im_factura_id=fa
    and o.clase='productos' and o.estado not in('completo','cancelado')) then
  raise exception 'Hay una corrección de productos pendiente. Completala o conciliala antes de vincular otra NC';
 end if;
 return new;
end $$;
drop trigger if exists integridad_vinculo_correccion on hojas_ruta_ajustes;
create trigger integridad_vinculo_correccion before insert or update of im_ajuste_id,im_comprobante_id,tipo on hojas_ruta_ajustes
 for each row execute function controlar_vinculo_correccion();
revoke all on function facturas_de_entrega(uuid,text),ajuste_entrega_sin_conciliar(uuid,text,integer,integer),controlar_correccion_entrega(),controlar_vinculo_correccion() from public,anon,authenticated;
grant execute on function facturas_de_entrega(uuid,text),ajuste_entrega_sin_conciliar(uuid,text,integer,integer),controlar_correccion_entrega(),controlar_vinculo_correccion() to service_role;


create or replace function iniciar_operacion_factura(
  p_tenant uuid, p_id uuid, p_factura text, p_version bigint, p_clase text,
  p_peticion jsonb, p_componentes jsonb, p_originales jsonb, p_finales jsonb, p_usuario uuid
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare e facturas_estado_correccion; o facturas_operaciones;
begin
  -- Orden único con mutar_reparto: tenant antes de factura/operación.
  insert into reparto_control(tenant_id) values(p_tenant) on conflict do nothing;
  perform 1 from reparto_control where tenant_id=p_tenant for update;
  insert into facturas_estado_correccion(tenant_id,im_factura_id,originales,renglones)
    values(p_tenant,p_factura,p_originales,p_originales) on conflict do nothing;
  select * into e from facturas_estado_correccion
    where tenant_id=p_tenant and im_factura_id=p_factura for update;
  select * into o from facturas_operaciones where tenant_id=p_tenant and id=p_id;
  if found then
    if o.im_factura_id<>p_factura or o.clase<>p_clase or o.peticion<>p_peticion then
      raise exception 'El identificador de operación pertenece a otra petición';
    end if;
    return to_jsonb(o);
  end if;
  if e.operacion_id is not null then raise exception 'Hay una operación pendiente de esta factura. Retomá o conciliá esa operación.'; end if;
  if e.version<>p_version or e.originales<>p_originales then
    raise exception 'La factura cambió desde la revisión. Volvé a abrirla.';
  end if;
  if p_clase='productos' and exists(select 1 from facturas_correcciones
      where tenant_id=p_tenant and im_factura_id=p_factura and operacion_id is null) then
    raise exception 'Esta factura tiene notas anteriores sin estado reconciliado. Corregila en InfoManager.';
  end if;
  if jsonb_array_length(p_componentes)<1 then raise exception 'No hay comprobantes para emitir'; end if;
  insert into facturas_operaciones(tenant_id,id,im_factura_id,clase,peticion,componentes,finales,creado_por)
    values(p_tenant,p_id,p_factura,p_clase,p_peticion,p_componentes,p_finales,p_usuario) returning * into o;
  update facturas_estado_correccion set operacion_id=p_id where tenant_id=p_tenant and im_factura_id=p_factura;
  return to_jsonb(o);
end $$;

create or replace function tomar_paso_factura(p_tenant uuid,p_id uuid,p_indice integer,p_token uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare o facturas_operaciones;
begin
  -- Orden único con mutar_reparto: tenant antes de factura/operación.
  insert into reparto_control(tenant_id) values(p_tenant) on conflict do nothing;
  perform 1 from reparto_control where tenant_id=p_tenant for update;
  update facturas_operaciones set estado='emitiendo',token=p_token,error=null,updated_at=now()
    where tenant_id=p_tenant and id=p_id and estado='listo' and indice=p_indice returning * into o;
  if not found then raise exception 'La operación está en curso o requiere conciliación. No se reemitió nada.'; end if;
  return to_jsonb(o);
end $$;

create or replace function terminar_paso_factura(
  p_tenant uuid,p_id uuid,p_token uuid,p_resultado jsonb,p_error text,p_incierto boolean
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare o facturas_operaciones; c jsonb; terminado boolean;
begin
  -- Orden único con mutar_reparto: tenant antes de factura/operación.
  insert into reparto_control(tenant_id) values(p_tenant) on conflict do nothing;
  perform 1 from reparto_control where tenant_id=p_tenant for update;
  -- Mismo orden de locks que iniciar_operacion_factura.
  perform 1 from facturas_estado_correccion e join facturas_operaciones x
    on x.tenant_id=e.tenant_id and x.im_factura_id=e.im_factura_id
    where x.tenant_id=p_tenant and x.id=p_id for update of e;
  select * into o from facturas_operaciones where tenant_id=p_tenant and id=p_id for update;
  if o.token is distinct from p_token or o.estado<>'emitiendo' then raise exception 'No sos el titular de esta emisión'; end if;
  if p_resultado is null then
    update facturas_operaciones set estado=case when p_incierto then 'incierto' else 'listo' end,
      error=p_error,token=null,updated_at=now() where tenant_id=p_tenant and id=p_id returning * into o;
    return to_jsonb(o);
  end if;
  if coalesce(p_resultado->>'id','') !~ '^[0-9]+$' or coalesce(p_resultado->>'id','') !~ '[1-9]' then raise exception 'Falta un ID decimal positivo del comprobante emitido'; end if;
  c=o.componentes->o.indice;
  insert into facturas_correcciones(tenant_id,im_factura_id,im_factura_numero,cod_cliente,
    tipo,im_comprobante_id,numero,total,motivo,creado_por,operacion_id)
    values(p_tenant,o.im_factura_id,(o.peticion->>'numero_factura')::int,
      (c->'datos'->>'cod_cliente')::int,p_resultado->>'tipo',p_resultado->>'id',
      (p_resultado->>'numero')::int,(c->'datos'->>'total')::numeric,o.peticion->>'motivo',o.creado_por,p_id);
  terminado=o.indice+1=jsonb_array_length(o.componentes);
  update facturas_operaciones set indice=indice+1,
    resultados=resultados||jsonb_build_array(p_resultado),estado=case when terminado then 'completo' else 'listo' end,
    token=null,error=null,updated_at=now() where tenant_id=p_tenant and id=p_id returning * into o;
  if terminado then
    update facturas_estado_correccion set version=version+1,operacion_id=null,
      renglones=case when o.clase='productos' then o.finales else renglones end
      where tenant_id=p_tenant and im_factura_id=o.im_factura_id;
  end if;
  return to_jsonb(o);
end $$;

create or replace function cancelar_operacion_factura(p_tenant uuid,p_id uuid)
returns boolean language plpgsql security invoker set search_path=public as $$
declare o facturas_operaciones;
begin
  -- Orden único con mutar_reparto: tenant antes de factura/operación.
  insert into reparto_control(tenant_id) values(p_tenant) on conflict do nothing;
  perform 1 from reparto_control where tenant_id=p_tenant for update;
  perform 1 from facturas_estado_correccion e join facturas_operaciones x
    on x.tenant_id=e.tenant_id and x.im_factura_id=e.im_factura_id
    where x.tenant_id=p_tenant and x.id=p_id for update of e;
  select * into o from facturas_operaciones where tenant_id=p_tenant and id=p_id for update;
  if o.estado is distinct from 'listo' or o.indice<>0 or o.resultados<>'[]'::jsonb or o.error is null then
    raise exception 'Sólo se puede cancelar un rechazo confirmado sin notas emitidas';
  end if;
  update facturas_operaciones set estado='cancelado',updated_at=now() where tenant_id=p_tenant and id=p_id;
  update facturas_estado_correccion set operacion_id=null,version=version+1
    where tenant_id=p_tenant and im_factura_id=o.im_factura_id and operacion_id=p_id;
  return true;
end $$;

create or replace function controlar_checkpoint_vinculo() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
 insert into reparto_control(tenant_id) values(new.tenant_id) on conflict do nothing;
 perform 1 from reparto_control where tenant_id=new.tenant_id for update;
 if exists(select 1 from hojas_ruta_ajustes a where a.tenant_id=new.tenant_id and a.im_ajuste_id=new.im_comprobante_id
   and (not exists(select 1 from facturas_de_entrega(new.tenant_id,a.im_comprobante_id) f where f.factura=new.im_factura_id)
     or exists(select 1 from facturas_de_entrega(new.tenant_id,a.im_comprobante_id) f where f.factura<>new.im_factura_id)))
  or exists(select 1 from facturas_correcciones c where c.tenant_id=new.tenant_id
     and c.im_comprobante_id=new.im_comprobante_id and c.im_factura_id<>new.im_factura_id) then
  raise exception 'La nota emitida está vinculada a otra factura o entrega ambigua. Conservar resultado y conciliar, sin reemitir';
 end if;
 return new;
end $$;
drop trigger if exists integridad_checkpoint_vinculo on facturas_correcciones;
create trigger integridad_checkpoint_vinculo before insert or update of im_comprobante_id,im_factura_id on facturas_correcciones
 for each row execute function controlar_checkpoint_vinculo();
revoke all on function controlar_checkpoint_vinculo() from public,anon,authenticated;
grant execute on function controlar_checkpoint_vinculo() to service_role;
notify pgrst, 'reload schema';

-- Lectura de capacidades. No crea datos, no toma reclamos, no consulta InfoManager.
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
  select jsonb_build_object('version',41,'listo',
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
