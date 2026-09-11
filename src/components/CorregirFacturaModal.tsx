import { useOperacionReparto } from './RepartoContext';
import { useDialogoReparto, estiloDialogo } from '../utils/useDialogoReparto';
import { useEffect, useMemo, useRef, useState } from 'react';
import { X, AlertTriangle, Trash2, Plus, Loader2, CheckCircle2 } from 'lucide-react';
import { authHeaders, getUser } from '../utils/auth';
import './CorregirFacturaModal.css';

/**
 * CORREGIR UNA FACTURA YA EMITIDA.
 *
 * Mati (09/09/2026): *"llaman los repartidores a facturación porque hay algún problema, se puso
 * mal una lista o hay un artículo mal cargado... que sea lo más rápido y ágil y simple posible"*.
 *
 * 🔴 La factura NO se toca: es un comprobante fiscal. Lo que se hace es dejarla como debería
 * quedar y el panel emite la nota de crédito por lo que baja y la de débito por lo que sube.
 *
 * 🔑 Toda la pantalla es una sola idea: **editás la factura como si se pudiera**, y abajo ves en
 * vivo qué comprobantes van a salir. Nadie tiene que pensar en notas de crédito hasta el final.
 */

interface Renglon {
  cod_articulo: number;
  cantidad: number;
  /** BRUTO, el precio de lista. Lo que la factura cobró es esto menos el descuento. */
  precio: number;
  descuento_porc?: number | null;
  descripcion?: string;
  iva_por?: number | null;
  cod_lista_precios?: number | null;
}

interface Factura {
  id: string; numero: number | null; fecha: string;
  cod_cliente: number; cliente_nombre: string | null;
  categoria_iva: string | null; letra: 'A' | 'B' | null;
}

interface Vista { nc: Renglon[]; nd: Renglon[]; total_nc: number; total_nd: number; diferencia: number }

const money = (n: number) => '$' + Number(n ?? 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/**
 * 🔴 Lo que el renglón cobra DE VERDAD. Mati (10/09/2026): *"al calcular la NC no está tomando el
 * descuento que tiene ese producto, lo hace por el total"*. La pantalla mostraba el bruto, así que
 * el TOTAL de la factura tampoco coincidía con la factura: en la FA B 50422 decía $699.708,64
 * donde InfoManager dice $587.301,91.
 */
const importeDe = (r: { cantidad: number; precio: number; descuento_porc?: number | null }) =>
  r.cantidad * r.precio * (1 - (Number(r.descuento_porc ?? 0) || 0) / 100);
const nun = (v: string) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) && n >= 0 ? n : 0; };

export function CorregirFacturaModal(
  { idFactura, onCerrar, onListo }: { idFactura: string; onCerrar: () => void; onListo: () => void },
) {
    const operacionGlobal = useOperacionReparto('CorregirFacturaModal');
  const [factura, setFactura] = useState<Factura | null>(null);
  const [originales, setOriginales] = useState<Renglon[]>([]);
  const [filas, setFilas] = useState<Renglon[]>([]);
  const [motivo, setMotivo] = useState('');
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [vista, setVista] = useState<Vista | null>(null);
  const [emitiendo, setEmitiendo] = useState(false);
  const [resultado, setResultado] = useState<{ emitidos: any[]; fallados: string[] } | null>(null);
  /** El buscador para agregar un producto que no está en la factura. */
  const [buscando, setBuscando] = useState('');
  const [candidatos, setCandidatos] = useState<any[]>([]);
  /** Renglones escritos a mano con plata adentro: la nota no los puede incluir. */
  const [sinArticulo, setSinArticulo] = useState<Array<{ descripcion: string; importe: number }>>([]);
  /**
   * 🔑 El modo financiero. Mati (10/09/2026): *"la NC puede ser financiera, por alguna diferencia
   * de cambio, o sea que no necesariamente tiene que dar de baja algún producto"*. Es otra cosa
   * que corregir renglones, así que es otra pantalla y no un caso raro de la misma.
   */
  const [modo, setModo] = useState<'productos' | 'financiera'>('productos');
  const [finTipo, setFinTipo] = useState<'NC' | 'ND'>('NC');
  const [finImporte, setFinImporte] = useState('');
  const [finMotivo, setFinMotivo] = useState('');
  const [version, setVersion] = useState<number | null>(null);
  const [bloqueoProductos, setBloqueoProductos] = useState<string | null>(null);
  const [pendiente, setPendiente] = useState<any>(null);
  const operacionId = useRef<string | null>(null);
  const envioEnCurso = useRef(false);
  const cerrar = () => { if (!envioEnCurso.current) onCerrar(); };
  const [propietarioBorrador] = useState(() => getUser()?.email ?? "sesion");
  const borradorCargado = useRef(false);
  const facturaActual = useRef<any>(null);
  const [borradorDesactualizado, setBorradorDesactualizado] = useState(false);
  const claveBorrador = `reparto:${propietarioBorrador}:borrador-correccion:${idFactura}`;
  const clavePendiente = `reparto:${propietarioBorrador}:correccion:${idFactura}`;

  useEffect(() => {
    const impedirSalida = (e: BeforeUnloadEvent) => { if (envioEnCurso.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', impedirSalida);
    return () => window.removeEventListener('beforeunload', impedirSalida);
  }, []);

  useEffect(() => {
    let vivo = true; const controller = new AbortController();
    (async () => {
      setCargando(true); setError(null);
      try {
        const r = await fetch(`/api/facturacion/corregir/${idFactura}`, { headers: authHeaders(), signal: controller.signal });
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.error ?? 'No se pudo leer la factura');
        if (!vivo) return;
        facturaActual.current = d;
        setFactura(d.factura);
        setVersion(d.version);
        setBloqueoProductos(d.bloqueo_productos ?? null);
        let local: any = null;
        try { local = JSON.parse(sessionStorage.getItem(clavePendiente) ?? 'null'); } catch { /* Sin borrador local. */ }
        const op = d.operacion;
        setPendiente(op ?? (local ? { id: local.body.operacion_id, clase: local.clase, estado: 'verificar', entrada: local.entrada, motivo: local.body.motivo, version: local.body.version, puede_retomar: true } : null));
        operacionId.current = op?.id ?? local?.body.operacion_id ?? null;
        setSinArticulo(d.sin_articulo ?? []);
        setOriginales(d.renglones);
        setFilas(d.renglones.map((x: Renglon) => ({ ...x })));
        try {
          const borrador = JSON.parse(sessionStorage.getItem(claveBorrador) ?? 'null');
          if (borrador && Array.isArray(borrador.filas) && Array.isArray(borrador.originales) && !op && !local) {
            setFilas(borrador.filas); setOriginales(borrador.originales); setVersion(borrador.version);
            setMotivo(borrador.motivo ?? ''); setModo(borrador.modo ?? 'productos');
            setFinTipo(borrador.finTipo ?? 'NC'); setFinImporte(borrador.finImporte ?? ''); setFinMotivo(borrador.finMotivo ?? '');
            setBorradorDesactualizado(borrador.version !== d.version);
          }
        } catch { /* No adoptar un borrador ilegible. */ }
        borradorCargado.current = true;
      } catch (e: any) {
        if (vivo) setError(e?.message ?? 'Error de conexión');
      } finally {
        if (vivo) setCargando(false);
      }
    })();
    return () => { vivo = false; controller.abort(); };
  }, [idFactura, clavePendiente, claveBorrador]);

  useEffect(() => {
    if (!borradorCargado.current || cargando || resultado || pendiente) return;
    try { sessionStorage.setItem(claveBorrador, JSON.stringify({ version, originales, filas, motivo, modo, finTipo, finImporte, finMotivo })); } catch { /* La sesión puede impedir almacenamiento. */ }
  }, [claveBorrador, version, originales, filas, motivo, modo, finTipo, finImporte, finMotivo, cargando, resultado, pendiente]);

  const totalOriginal = useMemo(
    () => originales.reduce((s, r) => s + importeDe(r), 0), [originales]);
  const totalNuevo = useMemo(
    () => filas.reduce((s, r) => s + importeDe(r), 0), [filas]);
  const hayCambios = useMemo(() => {
    const firma = (rs: Renglon[]) => JSON.stringify(rs.map(r => [r.cod_articulo, r.cantidad, r.precio, r.descuento_porc ?? 0])
      .sort((a, b) => Number(a[0]) - Number(b[0])));
    return firma(filas) !== firma(originales);
  }, [filas, originales]);

  /**
   * La previsualización sale del MISMO cálculo que después emite, en el servidor. Si la hiciera
   * la pantalla por su cuenta, podría prometer una cosa y salir otra.
   */
  useEffect(() => {
    setVista(null);
    if (!hayCambios || pendiente || bloqueoProductos || borradorDesactualizado) return;
    let vivo = true; const controller = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await fetch('/api/facturacion/corregir', {
          method: 'POST', signal: controller.signal, headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ im_factura_id: idFactura, renglones: filas, version }),
        });
        const d = await r.json().catch(() => null);
        if (vivo) setVista(r.ok ? d : null);
      } catch { if (vivo) setVista(null); }
    }, 350);   // sin esto sale una consulta por tecla mientras se escribe un precio
    return () => { vivo = false; controller.abort(); clearTimeout(t); };
  }, [filas, hayCambios, idFactura, version, pendiente, bloqueoProductos, borradorDesactualizado]);

  // Buscar un producto para agregar. Reusa el buscador del catálogo que ya usa el vendedor.
  useEffect(() => {
    const q = buscando.trim();
    if (q.length < 2) { setCandidatos([]); return; }
    let vivo = true; const controller = new AbortController();
    setCandidatos([]);
    const t = setTimeout(async () => {
      try {
        // El mismo buscador que usa el editor de presupuestos: catálogo completo, por
        // descripción o por código.
        const r = await fetch(`/api/articulos/buscar?q=${encodeURIComponent(q)}`, { headers: authHeaders(), signal: controller.signal });
        const d = await r.json().catch(() => null);
        if (vivo) setCandidatos(r.ok ? (d?.articulos ?? []).slice(0, 8) : []);
      } catch { if (vivo) setCandidatos([]); }
    }, 300);
    return () => { vivo = false; controller.abort(); clearTimeout(t); };
  }, [buscando]);

  const tocar = (i: number, campo: 'cantidad' | 'precio', valor: string) =>
    setFilas(fs => fs.map((f, j) => j === i ? { ...f, [campo]: nun(valor) } : f));

  const sacar = (i: number) => setFilas(fs => fs.filter((_, j) => j !== i));

  const agregar = (a: any) => {
    const cod = Number(a.cod_articulo);
    if (filas.some(f => f.cod_articulo === cod)) { setBuscando(''); setCandidatos([]); return; }
    setFilas(fs => [...fs, {
      cod_articulo: cod, cantidad: 1, precio: Number(a.precio_venta ?? 0) || 0,
      descuento_porc: 0,
      descripcion: String(a.descripcion ?? `Artículo ${cod}`),
      iva_por: 0, cod_lista_precios: null,
    }]);
    setBuscando(''); setCandidatos([]);
  };

  async function enviar(clase: 'productos' | 'financiera', entrada: any, motivoEnviar: string, versionOriginal: number | null = version) {
    if (envioEnCurso.current || borradorDesactualizado) return;
    if (!operacionGlobal.comenzar()) return;
    envioEnCurso.current = true;
    setEmitiendo(true); setError(null);
    const id = operacionId.current ?? crypto.randomUUID();
    operacionId.current = id;
    const body = { im_factura_id: idFactura, ...entrada, motivo: motivoEnviar, emitir: true, operacion_id: id, version: versionOriginal };
    const url = clase === 'productos' ? '/api/facturacion/corregir' : '/api/facturacion/nota-financiera';
    // El borrador conserva exactamente la petición ante pérdida de respuesta o recarga.
    try { sessionStorage.setItem(clavePendiente, JSON.stringify({ clase, entrada, body })); } catch { /* El servidor conserva el journal. */ }
    setPendiente({ id, clase, entrada, motivo: motivoEnviar, version: versionOriginal, estado: 'verificar', puede_retomar: true });
    try {
      const r = await fetch(url, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error ?? 'No se pudo verificar el resultado. Retomá la misma operación.');
      if (!d.ok) {
        setPendiente(d.operacion ?? { id, clase, entrada, motivo: motivoEnviar, estado: 'incierto', puede_retomar: false });
        setError((d.fallados ?? []).join(' ')); onListo(); return;
      }
      try { sessionStorage.removeItem(clavePendiente); sessionStorage.removeItem(claveBorrador); borradorCargado.current = false; } catch { /* Sin persistencia local. */ }
      setPendiente(null);
      setResultado({ emitidos: d.emitidos ?? [], fallados: d.fallados ?? [] });
      onListo();
    } catch (e: any) {
      setError(e?.message ?? 'Se perdió la respuesta. Conservamos la misma operación para verificarla.');
    } finally {
      envioEnCurso.current = false; setEmitiendo(false); operacionGlobal.terminar();
    }
  }

  async function emitirFinanciera() {
    const importe = nun(finImporte);
    if (!(importe > 0) || !finMotivo.trim() || pendiente) return;
    if (!confirm(`Se va a emitir una ${finTipo} por ${money(importe)} en InfoManager.\nMotivo: ${finMotivo.trim()}\n¿Seguimos?`)) return;
    await enviar('financiera', { tipo: finTipo, importe }, finMotivo.trim());
  }

  async function emitir() {
    if (!vista || pendiente || bloqueoProductos) return;
    const detalle = [vista.nc.length ? `NC ${money(vista.total_nc)}` : '', vista.nd.length ? `ND ${money(vista.total_nd)}` : ''].filter(Boolean).join(' y ');
    if (!confirm(`Se va a emitir ${detalle} en InfoManager.\n¿Seguimos?`)) return;
    await enviar('productos', { renglones: filas }, motivo);
  }

  const dialogo = useDialogoReparto(cerrar);
  return (
    <dialog ref={dialogo} style={estiloDialogo} aria-label="Corregir factura" className="cf-fondo" onClick={e => { if (e.target === e.currentTarget) cerrar(); }}>
      <div className="cf-modal">
        <header className="cf-header">
          <h3>
            Corregir factura {factura?.letra ?? ''} {factura?.numero ?? ''}
            {factura?.cliente_nombre && <small> · {factura.cliente_nombre}</small>}
          </h3>
          <button onClick={cerrar} disabled={emitiendo} aria-label="Cerrar corrección"><X size={18} /></button>
        </header>

        {cargando && <p className="cf-cargando"><Loader2 size={16} className="spin" /> Leyendo la factura en InfoManager…</p>}
        {error && <div className="cf-error"><AlertTriangle size={15} /> <span>{error}</span></div>}

        {borradorDesactualizado && <div className="cf-error" role="alert">La factura cambió desde este borrador. Se conserva para comparar; hay que revisar los datos actuales antes de emitir.
          <button onClick={() => { const d = facturaActual.current; setFilas(d.renglones); setOriginales(d.renglones); setVersion(d.version); setMotivo(''); setFinImporte(''); setFinMotivo(''); setBorradorDesactualizado(false); sessionStorage.removeItem(claveBorrador); }}>Descartar borrador y revisar versión actual</button>
        </div>}
        {pendiente && !resultado && (
          <div className="cf-error">
            <span>{pendiente.estado === 'listo' && pendiente.error && !pendiente.emitidos?.length
                ? 'InfoManager rechazó el intento. Corregí el motivo indicado antes de retomarlo.'
                : `Hay una operación ${pendiente.estado === 'listo' ? 'pendiente de terminar' : 'por verificar'}. Las notas confirmadas no se vuelven a emitir.`}
              {pendiente.error && <p>{pendiente.error}</p>}
              {pendiente.puede_retomar && <button disabled={emitiendo} onClick={() => void enviar(pendiente.clase, pendiente.entrada, pendiente.motivo, pendiente.version ?? version)}>Retomar / verificar operación</button>}
              {pendiente.puede_cancelar && <button disabled={emitiendo} onClick={async () => {
                if (!operacionGlobal.comenzar()) return; envioEnCurso.current = true; setEmitiendo(true);
                let cancelado = false;
                try {
                  const r = await fetch(`/api/facturacion/operaciones/${pendiente.id}`, { method: 'DELETE', headers: authHeaders() });
                  const d = await r.json(); if (!r.ok) throw new Error(d.error);
                  sessionStorage.removeItem(clavePendiente); cancelado = true; onListo();
                } catch (e: any) { setError(e.message); }
                finally { envioEnCurso.current = false; setEmitiendo(false); operacionGlobal.terminar(); }
                if (cancelado) cerrar();
              }}>Cancelar el intento rechazado</button>}
              {!pendiente.puede_retomar && ' Verificá los comprobantes en InfoManager antes de continuar.'}
            </span>
          </div>
        )}
        {bloqueoProductos && !resultado && <div className="cf-error">{bloqueoProductos}</div>}
        {resultado ? (
          <div className="cf-listo">
            {resultado.emitidos.map((e, i) => (
              <p key={i} className="cf-ok"><CheckCircle2 size={16} /> Salió la <b>{e.tipo} {e.numero}</b> por {money(e.total)}.</p>
            ))}
            {resultado.fallados.map((f, i) => (
              <p key={'f' + i} className="cf-mal"><AlertTriangle size={16} /> {f}</p>
            ))}
            <button className="cf-btn primario" onClick={cerrar}>Listo</button>
          </div>
        ) : !cargando && factura && (
          <fieldset disabled={emitiendo || !!pendiente || borradorDesactualizado} style={{ border: 0, padding: 0, minWidth: 0 }}>
            <div className="cf-solapas">
              <button className={modo === 'productos' ? 'activa' : ''} onClick={() => setModo('productos')}>
                Corregir productos
              </button>
              <button className={modo === 'financiera' ? 'activa' : ''} onClick={() => setModo('financiera')}>
                Ajuste financiero
              </button>
            </div>

            {modo === 'financiera' ? (
              <div className="cf-financiera">
                {/* 🔑 No saca mercadería: es plata. Diferencia de cambio, intereses, bonificación. */}
                <p className="cf-nota">
                  Para lo que no saca mercadería: una diferencia de cambio, intereses, una
                  bonificación. Va contra la factura {factura.numero}, así que la hoja de ruta lo
                  descuenta del pedido.
                </p>
                <div className="cf-fila-fin">
                  <label>
                    <span>Comprobante</span>
                    <select value={finTipo} onChange={e => setFinTipo(e.target.value as 'NC' | 'ND')}>
                      <option value="NC">Nota de crédito · le devolvemos plata</option>
                      <option value="ND">Nota de débito · le cobramos de más</option>
                    </select>
                  </label>
                  <label>
                    <span>Importe</span>
                    <input inputMode="decimal" value={finImporte} placeholder="0,00"
                           onChange={e => setFinImporte(e.target.value)} />
                  </label>
                </div>
                <label className="cf-fila-motivo">
                  <span>Motivo</span>
                  <input value={finMotivo} maxLength={100}
                         onChange={e => setFinMotivo(e.target.value)}
                         placeholder="Diferencia por cambio de mercadería, interés factura 18/8…" />
                </label>
                {nun(finImporte) > 0 && finMotivo.trim() && (
                  <p className="cf-dif">
                    {finTipo === 'NC'
                      ? <>Se le devuelven <b>{money(nun(finImporte))}</b>.</>
                      : <>Se le cobran <b>{money(nun(finImporte))}</b> de más.</>}
                  </p>
                )}
                <div className="cf-pie">
                  <button className="cf-btn" onClick={cerrar} disabled={emitiendo}>Cancelar</button>
                  <button className="cf-btn primario" onClick={() => void emitirFinanciera()}
                          disabled={emitiendo || !(nun(finImporte) > 0) || !finMotivo.trim()}>
                    {emitiendo ? <><Loader2 size={15} className="spin" /> Emitiendo…</>
                      : `Emitir la ${finTipo === 'NC' ? 'nota de crédito' : 'nota de débito'}`}
                  </button>
                </div>
              </div>
            ) : (
            <>
            {/* 🪤 La factura no se modifica. Que se lea antes de tocar nada. */}
            <p className="cf-nota">
              La factura {factura.numero} no se toca: es un comprobante fiscal. Dejá los renglones
              como tendrían que haber quedado y abajo vas a ver qué notas salen.
            </p>

            {/* 🔴 Plata de la factura que la nota no puede tocar: IM exige código de artículo. */}
            {!!sinArticulo.length && (
              <div className="cf-error cf-sinart">
                <AlertTriangle size={15} />
                <span>
                  Esta factura tiene {sinArticulo.length === 1 ? 'un renglón escrito a mano' : `${sinArticulo.length} renglones escritos a mano`} por{' '}
                  <b>{money(sinArticulo.reduce((s, r) => s + r.importe, 0))}</b>
                  {' '}({sinArticulo.map(r => r.descripcion).join(', ')}) que <b>no entran</b> en la
                  nota, porque InfoManager exige un código de artículo. Si hay que devolver eso
                  también, esa parte va por InfoManager.
                </span>
              </div>
            )}

            <table className="cf-tabla">
              <thead>
                <tr>
                  <th>Producto</th><th className="n">Cantidad</th><th className="n">Precio</th>
                  <th className="n">Desc.</th>
                  <th className="n">Importe</th><th className="n">Facturado</th><th />
                </tr>
              </thead>
              <tbody>
                {filas.map((f, i) => {
                  const orig = originales.find(o => o.cod_articulo === f.cod_articulo);
                  const cambio = !orig || Math.abs(orig.cantidad - f.cantidad) > 0.0001
                    || Math.abs(orig.precio - f.precio) > 0.00005;
                  return (
                    <tr key={f.cod_articulo} className={cambio ? 'cambiado' : ''}>
                      <td>{f.descripcion ?? `Artículo ${f.cod_articulo}`}</td>
                      <td className="n">
                        <input aria-label={`Cantidad de ${f.descripcion}`} inputMode="decimal" value={String(f.cantidad)}
                               onChange={e => tocar(i, 'cantidad', e.target.value)} />
                      </td>
                      <td className="n">
                        <input aria-label={`Precio de ${f.descripcion}`} inputMode="decimal" value={String(f.precio)}
                               onChange={e => tocar(i, 'precio', e.target.value)} />
                      </td>
                      {/* 🪤 De sólo lectura: el descuento es el que trae la factura. Para corregirlo
                          se toca el precio, que es lo que la oficina ya sabe hacer. */}
                      <td className="n cf-desc">{f.descuento_porc ? `${f.descuento_porc}%` : '—'}</td>
                      <td className="n">{money(importeDe(f))}</td>
                      <td className="n cf-antes">
                        {orig ? money(importeDe(orig)) : <span className="cf-nuevo">nuevo</span>}
                      </td>
                      <td className="c">
                        <button className="cf-sacar" title="Sacar este producto" onClick={() => sacar(i)}>
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {/* Los que se sacaron: siguen a la vista, si no se pierde qué se quitó. */}
                {originales.filter(o => !filas.some(f => f.cod_articulo === o.cod_articulo)).map(o => (
                  <tr key={'out' + o.cod_articulo} className="sacado">
                    <td>{o.descripcion ?? `Artículo ${o.cod_articulo}`}</td>
                    <td className="n">—</td><td className="n">—</td><td className="n">—</td><td className="n">—</td>
                    <td className="n cf-antes">{money(importeDe(o))}</td>
                    <td className="c">
                      <button className="cf-sacar" title="Volver a ponerlo"
                              onClick={() => setFilas(fs => [...fs, { ...o }])}>
                        <Plus size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4}>TOTAL</td>
                  <td className="n">{money(totalNuevo)}</td>
                  <td className="n cf-antes">{money(totalOriginal)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>

            <div className="cf-agregar">
              <input aria-label="Buscar producto para corregir" value={buscando} onChange={e => setBuscando(e.target.value)}
                     placeholder="Agregar un producto que faltó…" />
              {!!candidatos.length && (
                <ul className="cf-candidatos">
                  {candidatos.map(a => (
                    <li key={a.cod_articulo}>
                      <button onClick={() => agregar(a)}>
                        {a.descripcion} <span>{money(Number(a.precio_venta ?? 0))}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {vista && (
              <div className="cf-resumen">
                <h4>Lo que se va a emitir</h4>
                {!!vista.nc.length && (
                  <div className="cf-comp nc">
                    <b>Nota de crédito {factura.letra} · {money(vista.total_nc)}</b>
                    <ul>{vista.nc.map((r, i) => (
                      <li key={i}>
                        {r.descripcion ?? `Artículo ${r.cod_articulo}`} — {r.cantidad} × {money(r.precio)}
                        {r.descuento_porc ? ` − ${r.descuento_porc}%` : ''} = {money(importeDe(r))}
                      </li>
                    ))}</ul>
                  </div>
                )}
                {!!vista.nd.length && (
                  <div className="cf-comp nd">
                    <b>Nota de débito {factura.letra} · {money(vista.total_nd)}</b>
                    <ul>{vista.nd.map((r, i) => (
                      <li key={i}>
                        {r.descripcion ?? `Artículo ${r.cod_articulo}`} — {r.cantidad} × {money(r.precio)}
                        {r.descuento_porc ? ` − ${r.descuento_porc}%` : ''} = {money(importeDe(r))}
                      </li>
                    ))}</ul>
                  </div>
                )}
                <p className="cf-dif">
                  {vista.diferencia < 0
                    ? <>Al cliente se le devuelven <b>{money(-vista.diferencia)}</b>.</>
                    : <>Al cliente se le cobran <b>{money(vista.diferencia)}</b> de más.</>}
                </p>
              </div>
            )}

            <div className="cf-pie">
              <input aria-label="Motivo de la corrección" className="cf-motivo" value={motivo} maxLength={200}
                     onChange={e => setMotivo(e.target.value)}
                     placeholder="Motivo (va en las observaciones): lista mal cargada, no lo quiso…" />
              <button className="cf-btn" onClick={cerrar} disabled={emitiendo}>Cancelar</button>
              <button className="cf-btn primario" onClick={() => void emitir()}
                      disabled={!vista || emitiendo || !!bloqueoProductos || (!vista.nc.length && !vista.nd.length)}>
                {emitiendo ? <><Loader2 size={15} className="spin" /> Emitiendo…</> : 'Emitir la corrección'}
              </button>
            </div>
            </>
            )}
          </fieldset>
        )}
      </div>
    </dialog>
  );
}
