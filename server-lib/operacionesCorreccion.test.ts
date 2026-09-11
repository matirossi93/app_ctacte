import type { RenglonCorreccion } from './correccionFactura.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sb: vi.fn(), nc: vi.fn(), nd: vi.fn(), items: vi.fn(), cab: vi.fn(), catalogo:vi.fn(), precio:vi.fn(), ajuste:vi.fn() }));
vi.mock('./supabase.js', () => ({ sb: m.sb, TENANT_ID: 'tenant' }));
vi.mock('./infomanager.js', () => { const fuente = {
  cabeceraComprobante: m.cab, fetchVentasItems: m.items, fechaArgentina: () => '2026-09-11',
  fetchArticulosCatalogo: m.catalogo, getPrecioLista:m.precio,
  fetchClientesIMCon: async () => [{ cod_cliente: 1, categoria_iva: 'CF' }],
}; return { ...fuente, invalidarIM: vi.fn(), leerComprobante: async (id: string) => ({ cabecera: await (fuente as any).cabeceraComprobante(id), items: await (fuente as any).getItemsComprobante(id) }) }; });
vi.mock('./facturarIM.js', () => ({ emitirNotaCredito: m.nc, emitirNotaDebito: m.nd, letraDeFactura: () => 'B' }));
vi.mock('./pedidos.js', () => ({ usuarioIM: async () => 'oficina' }));
vi.mock('./vistaPresupuestos.js', () => ({ invalidarVista: vi.fn() }));
vi.mock('./vistaRemitos.js', () => ({ invalidarRemitos: vi.fn() }));
const { corregirFactura, notaFinanciera, verFacturaParaCorregir } = await import('./correccionFactura.js');
const { huellaPresupuesto, exigirHuella } = await import('./versionPresupuesto.js');

// DB en memoria para ejercitar el handler. La atomicidad SQL se comprueba además en PG aislado.
let estados: any[], operaciones: any[], notas: any[], falloCheckpoint: boolean, falloLectura: boolean;
const copy = (v: any) => JSON.parse(JSON.stringify(v));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const original = [{ iva_por:0, id_comprobante: '101', cod_articulo: 100, cantidad: 10, precio: 100, precio_orig: 100 }];
const cuerpo = (cantidad: number, op = 1, version = 0) => ({ im_factura_id: '101', emitir: true,
  operacion_id: id(op), version, renglones: [{ cod_articulo: 100, cantidad, precio: 100 }] as RenglonCorreccion[] });
function db() {
  return {
    from(table: string) {
      const rows = table === 'facturas_estado_correccion' ? estados : table === 'facturas_operaciones' ? operaciones : notas;
      const filtros: Array<(r: any) => boolean> = []; let single = false; let patch: any = null;
      const result = () => ({ data: falloLectura ? null : copy(single ? rows.filter(r => filtros.every(f => f(r)))[0] ?? null : rows.filter(r => filtros.every(f => f(r)))),
        error: falloLectura ? { message: 'schema unavailable' } : null });
      const q: any = { select: () => q, limit: () => q,
        eq: (k: string, v: any) => { filtros.push(r => r[k] === v); return q; },
        is: (k: string, v: any) => { filtros.push(r => (r[k] ?? null) === v); return q; },
        maybeSingle: () => { single = true; return q; },
        update: (v:any)=>{patch=v;return q;},
        then: (a: any, b: any) => { if(patch&&!falloLectura) rows.filter(r=>filtros.every(f=>f(r))).forEach(r=>Object.assign(r,patch)); return Promise.resolve(result()).then(a,b); },
      }; return q;
    },
    async rpc(name: string, p: any) {
      const error = (message: string) => ({ data: null, error: { code: 'P0001', message } });
      if (name === 'ajuste_entrega_sin_conciliar') return {data:m.ajuste(),error:null};
      if (name === 'iniciar_operacion_factura') {
        let e = estados.find(e => e.im_factura_id === p.p_factura);
        if (!e) { e = { tenant_id: 'tenant', im_factura_id: p.p_factura, version: 0, originales: p.p_originales, renglones: p.p_originales, operacion_id: null }; estados.push(e); }
        const previo = operaciones.find(o => o.id === p.p_id);
        if (previo) return { data: copy(previo), error: null };
        if (e.operacion_id || e.version !== p.p_version) return error('La factura tiene una operación o versión diferente');
        const o = { tenant_id: 'tenant', id: p.p_id, im_factura_id: p.p_factura, clase: p.p_clase,
          peticion: copy(p.p_peticion), componentes: copy(p.p_componentes), finales: copy(p.p_finales),
          indice: 0, estado: 'listo', resultados: [], error: null, token: null };
        operaciones.push(o); e.operacion_id = o.id; return { data: copy(o), error: null };
      }
      const o = operaciones.find(o => o.id === p.p_id);
      if (name === 'tomar_paso_factura') {
        if (o?.estado !== 'listo' || o.indice !== p.p_indice) return error('No se pudo reclamar');
        o.estado = 'emitiendo'; o.token = p.p_token; return { data: copy(o), error: null };
      }
      if (name === 'terminar_paso_factura') {
        if (falloCheckpoint) return error('Checkpoint no disponible');
        if (o?.token !== p.p_token || o.estado !== 'emitiendo') return error('Token distinto');
        if (!p.p_resultado) { o.estado = p.p_incierto ? 'incierto' : 'listo'; o.error = p.p_error; }
        else {
          notas.push({ tenant_id: 'tenant', im_factura_id: o.im_factura_id, operacion_id: o.id, ...copy(p.p_resultado) });
          o.resultados.push(copy(p.p_resultado)); o.indice++;
          o.estado = o.indice === o.componentes.length ? 'completo' : 'listo';
          if (o.estado === 'completo') { const e = estados.find(e => e.im_factura_id === o.im_factura_id); e.version++; e.operacion_id = null; if (o.clase === 'productos') e.renglones = o.finales; }
        }
        return { data: copy(o), error: null };
      }
      throw Error('RPC inesperada ' + name);
    },
  };
}
async function llamar(body: any, fn: any = corregirFactura) {
  const res: any = { code: 200, status(c: number) { this.code = c; return this; }, json(b: any) { this.body = b; } };
  await fn({ user: { rol: 'administrativo', sub: 'user' }, body, params: { idFactura: '101' } }, res);
  return res;
}
beforeEach(() => {
  vi.clearAllMocks(); estados = []; operaciones = []; notas = []; falloCheckpoint = false; falloLectura = false;
  m.sb.mockImplementation(db);
  m.ajuste.mockReturnValue(false);
  m.items.mockResolvedValue(copy(original));
  m.catalogo.mockResolvedValue(new Map([[13818,{iva_por:0}],[200,{iva_por:0}]])); m.precio.mockResolvedValue(null);
  m.cab.mockResolvedValue({ tipo_comprobante: 'FA', tipo_factura: 'B', existe: true, anulada: false,
    fecha: '2026-09-11', numero: 1, cod_cliente: 1, cod_empresa: 1, cod_vendedor: 2 });
  m.nc.mockImplementation(async () => ({ ok: true, id: String(1000+m.nc.mock.calls.length), tipo: 'NC B', numero: m.nc.mock.calls.length }));
  m.nd.mockImplementation(async () => ({ ok: true, id: String(2000+m.nd.mock.calls.length), tipo: 'ND B', numero: m.nd.mock.calls.length }));
});

describe('journal y estado corregido: handlers reales', () => {
  it('10→8→7 acredita 200 y 100; abrir devuelve 7 y versión2', async () => {
    expect((await llamar(cuerpo(8))).body.ok).toBe(true);
    expect((await llamar(cuerpo(7, 2, 1))).body.ok).toBe(true);
    expect(m.nc.mock.calls.map(c => c[0].total)).toEqual([200, 100]);
    const vista = await llamar({}, verFacturaParaCorregir);
    expect(vista.body.renglones[0].cantidad).toBe(7); expect(vista.body.version).toBe(2);
  });
  it('replay completado y dos requests con el mismo ID hacen un solo POST', async () => {
    await Promise.all([llamar(cuerpo(8)), llamar(cuerpo(8))]);
    expect(m.nc).toHaveBeenCalledTimes(1);
    expect((await llamar(cuerpo(8))).body.ok).toBe(true); expect(m.nc).toHaveBeenCalledTimes(1);
  });
  it('dos IDs de operación no corrigen concurrentemente la misma versión', async () => {
    const rs = await Promise.all([llamar(cuerpo(8)), llamar(cuerpo(7, 2))]);
    expect(m.nc).toHaveBeenCalledTimes(1); expect(rs.some(r => r.code === 409)).toBe(true);
  });
  it('checkpoint NC precede ND; retoma rechazo definitivo sólo ND', async () => {
    const body = cuerpo(8); body.renglones.push({ cod_articulo: 200, iva_por:0, cantidad: 1, precio: 50 });
    m.nd.mockImplementationOnce(async () => {
      expect(notas).toHaveLength(1); expect(notas[0].tipo).toBe('NC B');
      return { ok: false, sinRespuesta: false, error: 'rechazo explícito' };
    });
    expect((await llamar(body)).body.ok).toBe(false);
    expect((await llamar(body)).body.ok).toBe(true);
    expect(m.nc).toHaveBeenCalledTimes(1); expect(m.nd).toHaveBeenCalledTimes(2);
  });
  it('timeout NC bloquea ND y bloquea reintento', async () => {
    m.nc.mockResolvedValue({ ok: false, sinRespuesta: true, error: 'timeout' });
    const body = cuerpo(8); body.renglones.push({ cod_articulo: 200, iva_por:0, cantidad: 1, precio: 50 });
    expect((await llamar(body)).body.operacion.estado).toBe('incierto');
    expect((await llamar(body)).code).toBe(409);
    expect(m.nc).toHaveBeenCalledTimes(1); expect(m.nd).not.toHaveBeenCalled();
  });
  it('checkpoint fallido conserva emitiendo y número emitido en error; jamás reenvía', async () => {
    falloCheckpoint = true;
    const r = await llamar(cuerpo(8)); expect(r.code).toBe(503); expect(r.body.error).toContain('1001');
    expect(operaciones[0].resultado_por_conciliar).toMatchObject({id:'1001',tipo:'NC B'});
    falloCheckpoint = false;
    expect((await llamar(cuerpo(8))).code).toBe(409); expect(m.nc).toHaveBeenCalledTimes(1);
  });
  it('legacy sin estado y versión vieja se rechazan antes de emitir', async () => {
    notas.push({ tenant_id: 'tenant', im_factura_id: '101', operacion_id: null });
    expect((await llamar(cuerpo(8))).code).toBe(409); expect(m.nc).not.toHaveBeenCalled();
    notas = []; expect((await llamar(cuerpo(8, 1, 12))).code).toBe(409); expect(m.nc).not.toHaveBeenCalled();
  });
  it('más de4 decimales y body sin renglones no pueden convertirse en otra nota', async () => {
    expect((await llamar(cuerpo(1.00006))).code).toBe(409);
    expect((await llamar({ ...cuerpo(8), renglones: undefined })).code).toBe(400);
    expect(m.nc).not.toHaveBeenCalled(); expect(operaciones).toHaveLength(0);
  });
  it('misma operación con otro objetivo queda bloqueada', async () => {
    await llamar(cuerpo(8)); expect((await llamar(cuerpo(7))).code).toBe(409); expect(m.nc).toHaveBeenCalledTimes(1);
  });
  it('nota financiera también tiene idempotencia y marcador de conciliación', async () => {
    const body = { im_factura_id: '101', tipo: 'NC', importe: 100, motivo: 'Cambio', emitir: true, operacion_id: id(1), version: 0 };
    await llamar(body, notaFinanciera); await llamar(body, notaFinanciera);
    expect(m.nc).toHaveBeenCalledTimes(1); expect(m.nc.mock.calls[0][0].observaciones).toContain(`[OP:${id(1)}:NC]`);
  });
  it('sin schema/lectura o con comprobante de otra empresa no se emite', async () => {
    falloLectura = true; expect((await llamar(cuerpo(8))).code).toBe(503); falloLectura = false;
    m.cab.mockResolvedValue({ tipo_comprobante: 'FA', cod_empresa: 2 });
    expect((await llamar(cuerpo(8))).code).toBe(409); expect(m.nc).not.toHaveBeenCalled();
  });
});

it('la huella es estable entre formatos/orden y ata notas libres, dinero e identidad', () => {
  const cab = { cod_cliente: 1, cod_empresa: 1, cod_vendedor: '2', fecha: '2026-09-11T00:00:00', observaciones: ' hola ' };
  const items = [{ cod_articulo: 1, cantidad: 2, precio_orig: 0, precio: 100, detalle: 'Nombre anterior' },
    { cod_articulo: 0, cantidad: 1, precio: 0, detalle: 'Entregar el jueves' }];
  const h = huellaPresupuesto('101', cab, items);
  expect(huellaPresupuesto('101', { ...cab, cod_vendedor: 2, fecha: '2026-09-11' }, [...items].reverse().map(i => i.cod_articulo ? { ...i, precio_orig: 100, detalle: 'Nombre nuevo' } : i))).toBe(h);
  expect(() => exigirHuella(undefined, h)).toThrow();
  expect(() => exigirHuella(h, huellaPresupuesto('102', cab, items))).toThrow();
  expect(huellaPresupuesto('101', cab, [{ ...items[0], cantidad: 3 }, items[1]])).not.toBe(h);
  expect(huellaPresupuesto('101', cab, [items[0], { ...items[1], detalle: 'Entregar el viernes' }])).not.toBe(h);
});


describe('identidad fiscal y precisión autoritativas', () => {
  it('IVA del navegador no puede cambiar original21 a0; omitirlo conserva21', async()=>{
    m.items.mockResolvedValue([{...original[0],iva_por:21}]);
    const b=cuerpo(12); b.renglones[0].iva_por=0;
    expect((await llamar(b)).code).toBe(409); expect(m.nd).not.toHaveBeenCalled();
    delete b.renglones[0].iva_por;
    expect((await llamar(b)).body.ok).toBe(true); expect(m.nd.mock.calls[0][0].items[0].iva_por).toBe(21);
    expect(m.catalogo).not.toHaveBeenCalled(); expect(m.precio).not.toHaveBeenCalled();
  });
  it('IVA original desconocido y mezcla del mismo código bloquean sin journal', async()=>{
    m.items.mockResolvedValue([{...original[0],iva_por:undefined}]);
    expect((await llamar(cuerpo(8))).code).toBe(409);
    m.items.mockResolvedValue([{...original[0],iva_por:0},{...original[0],iva_por:21}]);
    expect((await llamar(cuerpo(8))).code).toBe(409); expect(operaciones).toHaveLength(0);
  });
  it('nuevo usa fallback puntual IVA explícito y bloquea si no existe', async()=>{
    m.catalogo.mockResolvedValue(new Map());
    const b=cuerpo(10);b.renglones.push({cod_articulo:200,cantidad:1,precio:50,cod_lista_precios:12});
    expect((await llamar(b)).code).toBe(409);expect(m.nd).not.toHaveBeenCalled();
    m.precio.mockResolvedValue({cod_articulo:200,iva:0,iva_verificada:10.5});
    expect((await llamar(b)).body.ok).toBe(true);expect(m.nd.mock.calls[0][0].items[0].iva_por).toBe(10.5);
    expect(m.precio).toHaveBeenLastCalledWith(200,12);
  });
  it('letra originalA y rutaB bloquean; GET muestra letra original', async()=>{
    m.cab.mockResolvedValue({...await m.cab(),tipo_factura:'A'});
    expect((await llamar(cuerpo(8))).code).toBe(409);expect(m.nc).not.toHaveBeenCalled();
    expect((await llamar({},verFacturaParaCorregir)).body.factura.letra).toBe('A');
  });
  it('reanudación no emite si cambió el cliente o falta snapshot de origen', async()=>{
    m.nc.mockResolvedValueOnce({ok:false,sinRespuesta:false,error:'Rechazo explícito'});
    await llamar(cuerpo(8)); const cab=await m.cab();m.cab.mockResolvedValue({...cab,cod_cliente:2});
    expect((await llamar(cuerpo(8))).code).toBe(409);expect(m.nc).toHaveBeenCalledTimes(1);
    m.cab.mockResolvedValue(cab);delete operaciones[0].peticion.origen;
    expect((await llamar(cuerpo(8))).code).toBe(409);expect(m.nc).toHaveBeenCalledTimes(1);
  });
  it('precio original de cinco decimales intacto permite cambiar cantidad sin cambiar dinero', async()=>{
    m.items.mockResolvedValue([{...original[0],precio:12023.45907,precio_orig:12023.45907}]);
    const b=cuerpo(8);b.renglones[0].precio=12023.45907;
    expect((await llamar(b)).body.ok).toBe(true);expect(m.nc.mock.calls[0][0].total).toBe(24046.92);
    expect(estados[0].renglones[0].precio).toBe(12023.45907);
  });
  it('ID de emisión inválido no cierra journal', async()=>{
    m.nc.mockResolvedValue({ok:true,id:'ERROR',numero:1,tipo:'NC B'});
    expect((await llamar(cuerpo(8))).body.operacion.estado).toBe('incierto');expect(notas).toHaveLength(0);
  });
});

it('NC externa de entrega bloquea cantidades pero permite nota financiera independiente', async()=>{
  m.ajuste.mockReturnValue(true);
  expect((await llamar(cuerpo(0))).code).toBe(409);expect(m.nc).not.toHaveBeenCalled();
  expect((await llamar({},verFacturaParaCorregir)).body.bloqueo_productos).toMatch(/entrega/);
  const fin={im_factura_id:'101',tipo:'NC',importe:10,motivo:'Interés',emitir:true,operacion_id:id(2),version:0};
  expect((await llamar(fin,notaFinanciera)).body.ok).toBe(true);
});
