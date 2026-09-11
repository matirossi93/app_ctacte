-- Intención durable, exclusión por factura y checkpoints de cada NC/ND.
-- Ningún estado emitiendo/incierto vence automáticamente: requiere conciliación.
create table if not exists facturas_estado_correccion (
  tenant_id uuid not null,
  im_factura_id text not null,
  version bigint not null default 0,
  originales jsonb not null,
  renglones jsonb not null,
  operacion_id uuid,
  primary key (tenant_id, im_factura_id)
);
create table if not exists facturas_operaciones (
  tenant_id uuid not null,
  id uuid not null,
  im_factura_id text not null,
  clase text not null check (clase in ('productos','financiera')),
  peticion jsonb not null,
  componentes jsonb not null,
  finales jsonb not null,
  indice integer not null default 0,
  estado text not null default 'listo' check (estado in ('listo','emitiendo','incierto','completo','cancelado')),
  token uuid,
  resultados jsonb not null default '[]',
  error text,
  creado_por uuid references usuarios(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, im_factura_id) references facturas_estado_correccion
);
create index if not exists facturas_operaciones_factura_idx on facturas_operaciones(tenant_id, im_factura_id);
alter table facturas_correcciones add column if not exists operacion_id uuid;
alter table presupuestos_revision add column if not exists huella text;
alter table presupuestos_facturados add column if not exists estado_emision text;
alter table presupuestos_facturados add column if not exists claim_token uuid;
-- Sólo los completados tienen estado inequívoco. Los pendientes legacy quedan bloqueados.
update presupuestos_facturados set estado_emision = 'completo'
where estado_emision is null and facturado_at is not null;

alter table facturas_estado_correccion enable row level security;
alter table facturas_operaciones enable row level security;
drop policy if exists facturas_estado_service on facturas_estado_correccion;
create policy facturas_estado_service on facturas_estado_correccion for all to service_role using (true) with check (true);
drop policy if exists facturas_operaciones_service on facturas_operaciones;
create policy facturas_operaciones_service on facturas_operaciones for all to service_role using (true) with check (true);

create or replace function iniciar_operacion_factura(
  p_tenant uuid, p_id uuid, p_factura text, p_version bigint, p_clase text,
  p_peticion jsonb, p_componentes jsonb, p_originales jsonb, p_finales jsonb, p_usuario uuid
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare e facturas_estado_correccion; o facturas_operaciones;
begin
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

-- CAS por índice + token: sólo el ganador puede hacer el POST externo.
create or replace function tomar_paso_factura(p_tenant uuid,p_id uuid,p_indice integer,p_token uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare o facturas_operaciones;
begin
  update facturas_operaciones set estado='emitiendo',token=p_token,error=null,updated_at=now()
    where tenant_id=p_tenant and id=p_id and estado='listo' and indice=p_indice returning * into o;
  if not found then raise exception 'La operación está en curso o requiere conciliación. No se reemitió nada.'; end if;
  return to_jsonb(o);
end $$;

-- Inserción del vínculo y avance del journal son una sola transacción.
create or replace function terminar_paso_factura(
  p_tenant uuid,p_id uuid,p_token uuid,p_resultado jsonb,p_error text,p_incierto boolean
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare o facturas_operaciones; c jsonb; terminado boolean;
begin
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
  if coalesce(p_resultado->>'id','')='' then raise exception 'Falta identificar el comprobante emitido'; end if;
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

revoke all on function iniciar_operacion_factura(uuid,uuid,text,bigint,text,jsonb,jsonb,jsonb,jsonb,uuid) from public,anon,authenticated;
revoke all on function tomar_paso_factura(uuid,uuid,integer,uuid) from public,anon,authenticated;
revoke all on function terminar_paso_factura(uuid,uuid,uuid,jsonb,text,boolean) from public,anon,authenticated;
grant execute on function iniciar_operacion_factura(uuid,uuid,text,bigint,text,jsonb,jsonb,jsonb,jsonb,uuid) to service_role;
grant execute on function tomar_paso_factura(uuid,uuid,integer,uuid) to service_role;
grant execute on function terminar_paso_factura(uuid,uuid,uuid,jsonb,text,boolean) to service_role;

create table if not exists presupuestos_control (
  tenant_id uuid not null, im_comprobante_id text not null,
  token uuid, actividad text, updated_at timestamptz not null default now(),
  primary key(tenant_id,im_comprobante_id)
);
alter table presupuestos_control enable row level security;
drop policy if exists presupuestos_control_service on presupuestos_control;
create policy presupuestos_control_service on presupuestos_control for all to service_role using(true) with check(true);
create or replace function reclamar_presupuesto(p_tenant uuid,p_id text,p_token uuid,p_actividad text)
returns boolean language plpgsql security invoker set search_path=public as $$
begin
  insert into presupuestos_control(tenant_id,im_comprobante_id) values(p_tenant,p_id) on conflict do nothing;
  update presupuestos_control set token=p_token,actividad=p_actividad,updated_at=now()
    where tenant_id=p_tenant and im_comprobante_id=p_id and token is null;
  return found;
end $$;
create or replace function soltar_presupuesto(p_tenant uuid,p_id text,p_token uuid)
returns boolean language plpgsql security invoker set search_path=public as $$
begin
  update presupuestos_control set token=null,actividad=null,updated_at=now()
    where tenant_id=p_tenant and im_comprobante_id=p_id and token=p_token;
  return found;
end $$;
create or replace function tomar_remito(p_tenant uuid,p_id text,p_token uuid)
returns boolean language plpgsql security invoker set search_path=public as $$
begin
  update presupuestos_facturados set estado_emision='remito_emitiendo',claim_token=p_token,reclamado_at=now()
    where tenant_id=p_tenant and im_comprobante_id=p_id and im_factura_id is not null
      and facturado_at is null and im_remito_id is null and estado_emision='remito_pendiente';
  return found;
end $$;
revoke all on function reclamar_presupuesto(uuid,text,uuid,text) from public,anon,authenticated;
revoke all on function soltar_presupuesto(uuid,text,uuid) from public,anon,authenticated;
revoke all on function tomar_remito(uuid,text,uuid) from public,anon,authenticated;
grant execute on function reclamar_presupuesto(uuid,text,uuid,text) to service_role;
grant execute on function soltar_presupuesto(uuid,text,uuid) to service_role;
grant execute on function tomar_remito(uuid,text,uuid) to service_role;

alter table presupuestos_facturados add column if not exists historial_remitos jsonb not null default '[]';
alter table facturas_operaciones drop constraint if exists facturas_operaciones_estado_check;
alter table facturas_operaciones add constraint facturas_operaciones_estado_check check(estado in ('listo','emitiendo','incierto','completo','cancelado'));
create or replace function cancelar_operacion_factura(p_tenant uuid,p_id uuid)
returns boolean language plpgsql security invoker set search_path=public as $$
declare o facturas_operaciones;
begin
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
revoke all on function cancelar_operacion_factura(uuid,uuid) from public,anon,authenticated;
grant execute on function cancelar_operacion_factura(uuid,uuid) to service_role;

notify pgrst, 'reload schema';
