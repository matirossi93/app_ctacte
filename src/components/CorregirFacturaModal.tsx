import { useEffect, useMemo, useState } from 'react';
import { X, AlertTriangle, Trash2, Plus, Loader2, CheckCircle2 } from 'lucide-react';
import { authHeaders } from '../utils/auth';
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
  precio: number;
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
const nun = (v: string) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) && n >= 0 ? n : 0; };

export function CorregirFacturaModal(
  { idFactura, onCerrar, onListo }: { idFactura: string; onCerrar: () => void; onListo: () => void },
) {
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

  useEffect(() => {
    let vivo = true;
    (async () => {
      setCargando(true); setError(null);
      try {
        const r = await fetch(`/api/facturacion/corregir/${idFactura}`, { headers: authHeaders() });
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.error ?? 'No se pudo leer la factura');
        if (!vivo) return;
        setFactura(d.factura);
        setOriginales(d.renglones);
        setFilas(d.renglones.map((x: Renglon) => ({ ...x })));
      } catch (e: any) {
        if (vivo) setError(e?.message ?? 'Error de conexión');
      } finally {
        if (vivo) setCargando(false);
      }
    })();
    return () => { vivo = false; };
  }, [idFactura]);

  const totalOriginal = useMemo(
    () => originales.reduce((s, r) => s + r.cantidad * r.precio, 0), [originales]);
  const totalNuevo = useMemo(
    () => filas.reduce((s, r) => s + r.cantidad * r.precio, 0), [filas]);
  const hayCambios = useMemo(() => Math.abs(totalNuevo - totalOriginal) > 0.005
    || filas.length !== originales.length, [totalNuevo, totalOriginal, filas.length, originales.length]);

  /**
   * La previsualización sale del MISMO cálculo que después emite, en el servidor. Si la hiciera
   * la pantalla por su cuenta, podría prometer una cosa y salir otra.
   */
  useEffect(() => {
    if (!hayCambios) { setVista(null); return; }
    let vivo = true;
    const t = setTimeout(async () => {
      try {
        const r = await fetch('/api/facturacion/corregir', {
          method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ im_factura_id: idFactura, renglones: filas }),
        });
        const d = await r.json().catch(() => null);
        if (vivo) setVista(r.ok ? d : null);
      } catch { if (vivo) setVista(null); }
    }, 350);   // sin esto sale una consulta por tecla mientras se escribe un precio
    return () => { vivo = false; clearTimeout(t); };
  }, [filas, hayCambios, idFactura]);

  // Buscar un producto para agregar. Reusa el buscador del catálogo que ya usa el vendedor.
  useEffect(() => {
    const q = buscando.trim();
    if (q.length < 2) { setCandidatos([]); return; }
    let vivo = true;
    const t = setTimeout(async () => {
      try {
        // El mismo buscador que usa el editor de presupuestos: catálogo completo, por
        // descripción o por código.
        const r = await fetch(`/api/articulos/buscar?q=${encodeURIComponent(q)}`, { headers: authHeaders() });
        const d = await r.json().catch(() => null);
        if (vivo) setCandidatos((d?.articulos ?? []).slice(0, 8));
      } catch { if (vivo) setCandidatos([]); }
    }, 300);
    return () => { vivo = false; clearTimeout(t); };
  }, [buscando]);

  const tocar = (i: number, campo: 'cantidad' | 'precio', valor: string) =>
    setFilas(fs => fs.map((f, j) => j === i ? { ...f, [campo]: nun(valor) } : f));

  const sacar = (i: number) => setFilas(fs => fs.filter((_, j) => j !== i));

  const agregar = (a: any) => {
    const cod = Number(a.cod_articulo);
    if (filas.some(f => f.cod_articulo === cod)) { setBuscando(''); setCandidatos([]); return; }
    setFilas(fs => [...fs, {
      cod_articulo: cod, cantidad: 1, precio: Number(a.precio_venta ?? 0) || 0,
      descripcion: String(a.descripcion ?? `Artículo ${cod}`),
      iva_por: 0, cod_lista_precios: null,
    }]);
    setBuscando(''); setCandidatos([]);
  };

  async function emitir() {
    if (!vista) return;
    const detalle = [
      vista.nc.length ? `una NOTA DE CRÉDITO por ${money(vista.total_nc)}` : null,
      vista.nd.length ? `una NOTA DE DÉBITO por ${money(vista.total_nd)}` : null,
    ].filter(Boolean).join(' y ');
    if (!confirm(`Se va a emitir ${detalle} en InfoManager.\n\nEs IRREVERSIBLE: toca la cuenta corriente del cliente.\n\n¿Seguimos?`)) return;
    setEmitiendo(true); setError(null);
    try {
      const r = await fetch('/api/facturacion/corregir', {
        method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ im_factura_id: idFactura, renglones: filas, motivo, emitir: true }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error ?? 'No se pudo emitir');
      setResultado({ emitidos: d.emitidos ?? [], fallados: d.fallados ?? [] });
      onListo();
    } catch (e: any) {
      setError(e?.message ?? 'Error de conexión');
    } finally {
      setEmitiendo(false);
    }
  }

  return (
    <div className="cf-fondo" onClick={e => { if (e.target === e.currentTarget) onCerrar(); }}>
      <div className="cf-modal">
        <header className="cf-header">
          <h3>
            Corregir factura {factura?.letra ?? ''} {factura?.numero ?? ''}
            {factura?.cliente_nombre && <small> · {factura.cliente_nombre}</small>}
          </h3>
          <button onClick={onCerrar}><X size={18} /></button>
        </header>

        {cargando && <p className="cf-cargando"><Loader2 size={16} className="spin" /> Leyendo la factura en InfoManager…</p>}
        {error && <div className="cf-error"><AlertTriangle size={15} /> <span>{error}</span></div>}

        {resultado ? (
          <div className="cf-listo">
            {resultado.emitidos.map((e, i) => (
              <p key={i} className="cf-ok"><CheckCircle2 size={16} /> Salió la <b>{e.tipo} {e.numero}</b> por {money(e.total)}.</p>
            ))}
            {resultado.fallados.map((f, i) => (
              <p key={'f' + i} className="cf-mal"><AlertTriangle size={16} /> {f}</p>
            ))}
            <button className="cf-btn primario" onClick={onCerrar}>Listo</button>
          </div>
        ) : !cargando && factura && (
          <>
            {/* 🪤 La factura no se modifica. Que se lea antes de tocar nada. */}
            <p className="cf-nota">
              La factura {factura.numero} no se toca: es un comprobante fiscal. Dejá los renglones
              como tendrían que haber quedado y abajo vas a ver qué notas salen.
            </p>

            <table className="cf-tabla">
              <thead>
                <tr>
                  <th>Producto</th><th className="n">Cantidad</th><th className="n">Precio</th>
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
                        <input inputMode="decimal" value={String(f.cantidad)}
                               onChange={e => tocar(i, 'cantidad', e.target.value)} />
                      </td>
                      <td className="n">
                        <input inputMode="decimal" value={String(f.precio)}
                               onChange={e => tocar(i, 'precio', e.target.value)} />
                      </td>
                      <td className="n">{money(f.cantidad * f.precio)}</td>
                      <td className="n cf-antes">
                        {orig ? money(orig.cantidad * orig.precio) : <span className="cf-nuevo">nuevo</span>}
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
                    <td className="n">—</td><td className="n">—</td><td className="n">—</td>
                    <td className="n cf-antes">{money(o.cantidad * o.precio)}</td>
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
                  <td colSpan={3}>TOTAL</td>
                  <td className="n">{money(totalNuevo)}</td>
                  <td className="n cf-antes">{money(totalOriginal)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>

            <div className="cf-agregar">
              <input value={buscando} onChange={e => setBuscando(e.target.value)}
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
                      <li key={i}>{r.descripcion ?? `Artículo ${r.cod_articulo}`} — {r.cantidad} × {money(r.precio)}</li>
                    ))}</ul>
                  </div>
                )}
                {!!vista.nd.length && (
                  <div className="cf-comp nd">
                    <b>Nota de débito {factura.letra} · {money(vista.total_nd)}</b>
                    <ul>{vista.nd.map((r, i) => (
                      <li key={i}>{r.descripcion ?? `Artículo ${r.cod_articulo}`} — {r.cantidad} × {money(r.precio)}</li>
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
              <input className="cf-motivo" value={motivo} maxLength={200}
                     onChange={e => setMotivo(e.target.value)}
                     placeholder="Motivo (va en las observaciones): lista mal cargada, no lo quiso…" />
              <button className="cf-btn" onClick={onCerrar} disabled={emitiendo}>Cancelar</button>
              <button className="cf-btn primario" onClick={() => void emitir()}
                      disabled={!vista || emitiendo || (!vista.nc.length && !vista.nd.length)}>
                {emitiendo ? <><Loader2 size={15} className="spin" /> Emitiendo…</> : 'Emitir la corrección'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
