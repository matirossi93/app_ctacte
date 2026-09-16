-- ═══════════════════════════════════════════════════════════════════════════════
-- VINCULAR NOTAS EXISTENTES: MISMAS GUARDAS PARA NC Y ND, Y LA QUE FALTABA
--
-- (1) Las funciones de la 041 miran sólo `tipo='nc'`. Habilitar ND sin extenderlas dejaría un
--     tipo de nota SIN NINGUNA protección: entraría como ajuste salteando la conciliación.
--
-- (2) 🔴 El filtro de "misma factura" era `o.clase='productos'`. Una emisión FINANCIERA incierta
--     de ESA factura no caía ahí (no es 'productos') ni en el filtro de "otra factura" (exige
--     `im_factura_id<>fa`): quedaba un hueco por el que se podía adoptar una nota y después
--     reintentar ese journal, contando la plata dos veces. Lo que define la incertidumbre es
--     TENER componentes NC/ND pendientes, no la etiqueta de la clase.
--     Comprobado contra Postgres: `supabase/tests/043_guardas_vinculo.sql` caso 3.
--
-- 🪤 No se editan las migraciones históricas: en producción ya corrieron. Esto las reemplaza.
-- Nada bloquea por operaciones ya 'completo' o 'cancelado' — eso sería un bloqueo eterno.
-- Todo en una transacción: si algo falla, no queda media guarda puesta.
-- ═══════════════════════════════════════════════════════════════════════════════
begin;

-- Toda nota de entrega, de cualquier tipo, cuenta como pendiente de conciliar cantidades.
create or replace function ajuste_entrega_sin_conciliar(p_tenant uuid,p_factura text,p_cliente integer,p_empresa integer)
returns boolean language sql volatile security invoker set search_path=public as $$
 select exists(
  select 1 from hojas_ruta_ajustes a
   where a.tenant_id=p_tenant and a.tipo in ('nc','nd')
    and (exists(select 1 from facturas_de_entrega(p_tenant,a.im_comprobante_id) f where f.factura=p_factura)
      or (a.cod_cliente=p_cliente and (a.cod_empresa=p_empresa or a.cod_empresa is null)
          and not exists(select 1 from facturas_de_entrega(p_tenant,a.im_comprobante_id))))
    -- Una nota del journal ya tiene semántica y estado; no se vuelve a descontar por vincularla.
    and not exists(select 1 from facturas_correcciones c where c.tenant_id=p_tenant
      and c.im_factura_id=p_factura and c.im_comprobante_id=a.im_ajuste_id and c.operacion_id is not null)
 )
$$;

-- ── Las guardas, en una función PROPIA ─────────────────────────────────────────
-- 🔑 Nombre nuevo a propósito: el disparador tiene que seguir llamándose como espera el RPC
-- publicado (`controlar_vinculo_correccion`), así que la existencia de ESE nombre no distingue la
-- versión vieja de la nueva. Ésta, en cambio, sólo puede existir si esta migración corrió, y es
-- lo que la comprobación de capacidad mira.
create or replace function controlar_vinculo_nota(
  p_tenant uuid,p_entrega text,p_cliente integer,p_empresa integer,p_tipo text,p_ajuste text
) returns void language plpgsql security invoker set search_path=public as $$
declare fa text; cantidad integer;
begin
 insert into reparto_control(tenant_id) values(p_tenant) on conflict do nothing;
 perform 1 from reparto_control where tenant_id=p_tenant for update;
 select count(*),min(factura) into cantidad,fa from facturas_de_entrega(p_tenant,p_entrega);
 if cantidad<>1 then raise exception 'La entrega no tiene una factura unívoca. Conciliá el vínculo antes de asociar la nota'; end if;

 -- Una nota pendiente de OTRA factura del mismo cliente puede ser ésta misma por otro camino.
 -- Se compara contra el MISMO tipo: un journal de ND no va a emitir la NC que se está adoptando.
 if exists(select 1 from facturas_operaciones o cross join lateral jsonb_array_elements(o.componentes) c
    where o.tenant_id=p_tenant and o.im_factura_id<>fa and o.estado not in('completo','cancelado')
      and c->>'tipo'=upper(p_tipo) and (c->'datos'->>'cod_cliente')::int=p_cliente
      and (c->'datos'->>'cod_empresa')::int=p_empresa) then
  raise exception 'Hay una nota pendiente de otra factura del mismo cliente/empresa. Conciliá antes de vincular';
 end if;

 -- Ya asociada a otra factura en el journal: vincularla acá la contaría dos veces.
 if exists(select 1 from facturas_correcciones c where c.tenant_id=p_tenant
    and c.im_comprobante_id=p_ajuste and c.im_factura_id<>fa) then
  raise exception 'Esa nota ya corresponde a otra factura. No se puede vincular a esta entrega';
 end if;

 -- 🔴 De ESTA factura: cualquier operación pendiente que pueda terminar emitiendo una nota.
 -- Una financiera con componentes NC/ND es exactamente la que podría haber emitido la que se
 -- está adoptando; no alcanzaba con mirar `clase='productos'`.
 if exists(select 1 from facturas_operaciones o where o.tenant_id=p_tenant and o.im_factura_id=fa
    and o.estado not in('completo','cancelado')
    and (o.clase='productos'
      or exists(select 1 from jsonb_array_elements(o.componentes) c where c->>'tipo' in ('NC','ND')))) then
  raise exception 'Hay una corrección pendiente de esta factura. Completala o conciliala antes de vincular una nota';
 end if;
end $$;

create or replace function controlar_vinculo_correccion() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
 -- 🔄 Antes: `if new.tipo<>'nc' then return new`. Una ND entraba sin ninguna guarda.
 if new.tipo not in ('nc','nd') then return new; end if;
 perform controlar_vinculo_nota(new.tenant_id,new.im_comprobante_id,new.cod_cliente,new.cod_empresa,new.tipo,new.im_ajuste_id);
 return new;
end $$;

revoke all on function ajuste_entrega_sin_conciliar(uuid,text,integer,integer),controlar_vinculo_correccion(),
  controlar_vinculo_nota(uuid,text,integer,integer,text,text) from public,anon,authenticated;
grant execute on function ajuste_entrega_sin_conciliar(uuid,text,integer,integer),controlar_vinculo_correccion(),
  controlar_vinculo_nota(uuid,text,integer,integer,text,text) to service_role;


-- ── Vincular, con la factura que el operador vio ───────────────────────────────
-- 🔴 `mutar_reparto` valida la entrega contra `hojas_ruta_pedidos.im_factura_id`, que es un
-- snapshot: entre que se abrió la pantalla y se confirmó, la entrega pudo quedar apareada a otra
-- factura y la nota terminaría descontando de un comprobante que nadie miró. Acá la identidad se
-- resuelve con `facturas_de_entrega` —la fuente que usan las guardas— y se compara contra la que
-- se mostró. Sin ese dato no se vincula.
--
-- 🪤 El lock de `reparto_control` NO alcanza para eso: serializa las RPC de reparto, pero el
-- aparear/desaparear de facturación escribe `presupuestos_facturados` con UPDATE directos que
-- nunca lo piden, y `facturas_de_entrega` es un SELECT sin bloqueo de fila. Por eso se toman
-- explícitamente las filas que DETERMINAN la factura, en orden de `id` para que dos vínculos
-- simultáneos no se traben entre sí, y se revalida después de insertar.
--
-- Límite conocido y declarado: un INSERT nuevo en `presupuestos_facturados` no lo frena ningún
-- `FOR UPDATE` —no hay fila que bloquear—. La revalidación posterior lo atrapa si ya está
-- confirmado; si se confirma DESPUÉS, nada lo alcanza retrospectivamente: el disparador ya corrió
-- y esta transacción ya cerró. Lo que se garantiza es la identidad DURANTE el vínculo, no
-- congelar la relación para siempre.
--
-- Primero el tenant en `reparto_control`, como `mutar_reparto`: tomarlos al revés en dos caminos
-- distintos es un abrazo mortal esperando.
create or replace function vincular_nota_existente(
  p_tenant uuid,p_actor uuid,p_hoja uuid,p_version bigint,p_ajuste jsonb,p_factura_esperada text
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare h hojas_ruta; fila hojas_ruta_pedidos; a hojas_ruta_ajustes; ids text[]; fa text; cantidad integer;
begin
 if p_tenant is null or p_actor is null then raise exception 'Falta identidad de la operación'; end if;
 if nullif(p_factura_esperada,'') is null then raise exception 'Falta la factura que se vio al vincular'; end if;
 insert into reparto_control(tenant_id) values(p_tenant) on conflict do nothing;
 perform 1 from reparto_control where tenant_id=p_tenant for update;

 select * into h from hojas_ruta where id=p_hoja and tenant_id=p_tenant;
 if not found then raise exception 'Hoja no encontrada'; end if;
 if h.estado<>'abierta' then raise exception 'La hoja no está abierta'; end if;
 if p_version is distinct from h.version then raise exception 'La hoja cambió. Actualizá antes de vincular'; end if;

 ids:=reparto_aliases(p_tenant,p_ajuste->>'im_comprobante_id');
 select * into fila from hojas_ruta_pedidos where hoja_id=p_hoja and im_comprobante_id=any(ids);
 if not found or fila.cod_empresa is null or fila.cod_empresa is distinct from (p_ajuste->>'cod_empresa')::int
    or fila.cod_cliente is distinct from (p_ajuste->>'cod_cliente')::int then
  raise exception 'La nota no corresponde a la empresa/cliente de la entrega verificada';
 end if;
 if exists(select 1 from hojas_ruta_ajustes where tenant_id=p_tenant and im_comprobante_id=any(ids) and emitido_at is null) then
  raise exception 'Hay un ajuste pendiente o incierto';
 end if;
 if nullif(p_ajuste->>'im_ajuste_id','') is null then raise exception 'Falta la identidad de la nota'; end if;
 if coalesce(p_ajuste->>'tipo','') not in ('nc','nd') then raise exception 'La nota tiene que ser de crédito o de débito'; end if;

 -- Las filas de las que sale la factura, bloqueadas antes de leerlas.
 perform 1 from presupuestos_facturados pf
  where pf.tenant_id=p_tenant and fila.im_comprobante_id in (pf.im_comprobante_id,pf.im_remito_id,pf.im_factura_id)
  order by pf.id for update;
 perform 1 from hojas_ruta_pedidos hp
  where hp.hoja_id in (select id from hojas_ruta where tenant_id=p_tenant)
    and fila.im_comprobante_id in (hp.im_comprobante_id,hp.im_remito_id,hp.im_factura_id)
  order by hp.id for update;

 select count(*),min(factura) into cantidad,fa from facturas_de_entrega(p_tenant,fila.im_comprobante_id);
 if cantidad<>1 then raise exception 'La entrega no tiene una factura unívoca. Conciliá el vínculo antes de asociar la nota'; end if;
 if fa is distinct from p_factura_esperada then
  raise exception 'La factura de esta entrega cambió desde que abriste la pantalla. Recargá y revisá antes de vincular';
 end if;

 a:=jsonb_populate_record(null::hojas_ruta_ajustes,p_ajuste);
 -- `items` vacío a propósito: esta nota no la emitimos nosotros, así que no hay renglones propios
 -- que conciliar. Es también lo que distingue una nota vinculada de una emitida por el panel.
 insert into hojas_ruta_ajustes(tenant_id,hoja_id,im_comprobante_id,cod_cliente,cliente_nombre,tipo,motivo,importe,items,
   im_ajuste_id,im_ajuste_numero,im_ajuste_tipo,emitido_at,reclamado_at,created_by,cod_empresa,estado_operacion)
  values(p_tenant,p_hoja,fila.im_comprobante_id,a.cod_cliente,a.cliente_nombre,a.tipo,a.motivo,a.importe,'[]',
   a.im_ajuste_id,a.im_ajuste_numero,a.im_ajuste_tipo,now(),now(),p_actor,a.cod_empresa,'completo') returning * into a;
 -- Revalidación después de escribir: si alguien confirmó otro apareo mientras tanto, esta
 -- transacción se va entera y la nota no queda colgada de una factura que nadie vio.
 select count(*),min(factura) into cantidad,fa from facturas_de_entrega(p_tenant,fila.im_comprobante_id);
 if cantidad<>1 or fa is distinct from p_factura_esperada then
  raise exception 'La factura de esta entrega cambió mientras se vinculaba. No se guardó nada; recargá y revisá';
 end if;
 update hojas_ruta set version=version+1 where tenant_id=p_tenant and id=p_hoja;
 return jsonb_build_object('ok',true,'filas',to_jsonb(a),'factura',fa,
   'version',(select version from hojas_ruta where id=p_hoja and tenant_id=p_tenant));
end $$;
revoke all on function vincular_nota_existente(uuid,uuid,uuid,bigint,jsonb,text) from public,anon,authenticated;
grant execute on function vincular_nota_existente(uuid,uuid,uuid,bigint,jsonb,text) to service_role;

-- ── Capacidad, no versión ──────────────────────────────────────────────────────
-- 🔑 `listo` sigue comprobando EXACTAMENTE lo de 41/42: aplicar este SQL no puede dejar en 503 a
-- la app publicada (mismo patrón que 042), y la app nueva no puede exigir esto para TODO — si el
-- SQL todavía no corrió, se apaga el vínculo de notas, no la facturación.
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
  select jsonb_build_object('version',41,'version_cierre',42,'version_vinculo',43,'vinculo_listo',(
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
