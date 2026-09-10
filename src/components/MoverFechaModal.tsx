import { useEffect, useState } from 'react';
import { X, AlertTriangle, Loader2, CalendarDays, CheckCircle2 } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import './MoverFechaModal.css';

/**
 * CAMBIAR LA FECHA DE UNA FACTURA YA EMITIDA.
 *
 * Mati (10/09/2026): *"necesito que podamos editar la fecha de la factura dentro de la app"*.
 * Pasa porque la oficina factura hoy el reparto de mañana: si se equivocan de día, el pedido no
 * aparece en la hoja donde lo buscan.
 *
 * 🔑 La fecha es uno de los TRES campos que InfoManager deja tocar de un comprobante emitido.
 * Los productos y los importes no: para eso está Corregir, que emite notas.
 *
 * 🪤 El remito se mueve junto por defecto. La hoja de ruta se arma con remitos, así que dejarlos
 * en días distintos es justo el problema que se viene a resolver.
 */
export function MoverFechaModal(
  { idFactura, onCerrar, onListo }: { idFactura: string; onCerrar: () => void; onListo: () => void },
) {
  const [factura, setFactura] = useState<{ numero: number | null; fecha: string; cliente_nombre: string | null; letra: string | null } | null>(null);
  const [fecha, setFecha] = useState('');
  const [moverRemito, setMoverRemito] = useState(true);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState<{ fecha: string; remito: { numero: number | null } | null; avisos: string[] } | null>(null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      setCargando(true); setError(null);
      try {
        // La misma lectura que usa Corregir: trae la factura como está hoy en InfoManager.
        const r = await fetch(`/api/facturacion/corregir/${idFactura}`, { headers: authHeaders() });
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.error ?? 'No se pudo leer la factura');
        if (!vivo) return;
        setFactura(d.factura);
        setFecha(String(d.factura?.fecha ?? '').slice(0, 10));
      } catch (e: any) {
        if (vivo) setError(e?.message ?? 'Error de conexión');
      } finally {
        if (vivo) setCargando(false);
      }
    })();
    return () => { vivo = false; };
  }, [idFactura]);

  const cambió = !!factura && fecha && fecha !== String(factura.fecha ?? '').slice(0, 10);

  async function guardar() {
    if (!cambió) return;
    setGuardando(true); setError(null);
    try {
      const r = await fetch(`/api/facturacion/${idFactura}/fecha`, {
        method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ fecha, mover_remito: moverRemito }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error ?? 'No se pudo mover la fecha');
      setListo({ fecha: d.fecha, remito: d.remito ?? null, avisos: d.avisos ?? [] });
    } catch (e: any) {
      setError(e?.message ?? 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="mf-fondo" onClick={e => { if (e.target === e.currentTarget) onCerrar(); }}>
      <div className="mf-modal">
        <header className="mf-header">
          <h3><CalendarDays size={16} /> Fecha de la factura {factura?.letra ?? ''} {factura?.numero ?? ''}</h3>
          <button onClick={onCerrar}><X size={18} /></button>
        </header>

        {cargando && <p className="mf-cargando"><Loader2 size={16} className="spin" /> Leyendo la factura…</p>}
        {error && <div className="mf-error"><AlertTriangle size={15} /> <span>{error}</span></div>}

        {listo ? (
          <div className="mf-listo">
            <p className="mf-ok"><CheckCircle2 size={16} /> La factura quedó fechada el <b>{listo.fecha}</b>.</p>
            {listo.remito && <p className="mf-ok"><CheckCircle2 size={16} /> El remito {listo.remito.numero ?? ''} también se movió.</p>}
            {listo.avisos.map((a, i) => <p key={i} className="mf-mal"><AlertTriangle size={16} /> {a}</p>)}
            <button className="mf-btn primario" onClick={onListo}>Listo</button>
          </div>
        ) : !cargando && factura && (
          <>
            <p className="mf-nota">
              {factura.cliente_nombre} · hoy está fechada el <b>{String(factura.fecha).slice(0, 10)}</b>.
              Se cambia sólo la fecha: los productos y los importes quedan como están.
            </p>
            <label className="mf-campo">
              <span>Nueva fecha</span>
              <input type="date" value={fecha} onChange={e => setFecha(e.target.value)} />
            </label>
            {/* 🪤 La hoja de ruta se arma con remitos: separarlos es el problema, no la solución. */}
            <label className="mf-check">
              <input type="checkbox" checked={moverRemito} onChange={e => setMoverRemito(e.target.checked)} />
              <span>Mover también el remito (la hoja de ruta se arma con el remito)</span>
            </label>
            <div className="mf-pie">
              <button className="mf-btn" onClick={onCerrar} disabled={guardando}>Cancelar</button>
              <button className="mf-btn primario" onClick={() => void guardar()} disabled={!cambió || guardando}>
                {guardando ? <><Loader2 size={15} className="spin" /> Moviendo…</> : 'Cambiar la fecha'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
