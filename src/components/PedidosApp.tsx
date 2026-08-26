import { useEffect, useMemo, useRef, useState } from 'react';
import {
    X, Search, User, ShoppingCart, Plus, Minus, Trash2, Send, Loader2,
    CheckCircle2, AlertCircle, ArrowLeft, PackageSearch, Wallet, Ban,
    Package, AlertTriangle,
} from 'lucide-react';
import { authHeaders } from '../utils/auth';
import './PedidosApp.css';

interface Props {
    onClose: () => void;
    clients?: Array<{ cod: string; name: string; localidad?: string }>;
}

interface ClienteOpt { cod: string; name: string; localidad?: string }
interface Credito { saldo: number; disponible: number; control_margen_venta: string }
interface CatItem { cod_articulo: number; descripcion: string; precio_venta: number }
interface CartItem { cod_articulo: number; descripcion: string; cantidad: number; precio: number; cod_lista: number }

/**
 * Listas mayoristas de IM. El vendedor la elige RENGLON POR RENGLON segun la
 * cantidad, que es como se trabaja hoy en InfoManager: el mismo pedido puede
 * tener un producto en Lista 2 y otro en Lista 3.
 */
const LISTAS = [
    { cod: 12, label: 'L1' },
    { cod: 13, label: 'L2' },
    { cod: 14, label: 'L3' },
    { cod: 15, label: 'L4' },
] as const;
const LISTA_DEFECTO = 12;
const NOMBRE_LISTA: Record<number, string> = { 12: 'L1', 13: 'L2', 14: 'L3', 15: 'L4' };

/** Lo que devuelve POST /api/pedidos/validar. */
interface AvisoLista {
    cod_articulo: number;
    lista_elegida: number;
    lista_sugerida: number | null;
    /** 'margen' = le vende más barato de lo que corresponde · 'cliente' = le cobra de más. */
    severidad: 'ok' | 'margen' | 'cliente' | 'sin_regla';
    mensaje: string | null;
}
interface ControlListas { bultos: number; promo_general: boolean; avisos: AvisoLista[] }

interface Pedido {
    id: string; cod_cliente: number; cliente_nombre: string | null; estado: string;
    im_numero: number | null; total_estimado: number; created_at: string;
}

type Step = 'cliente' | 'productos' | 'listo';

const money = (n: number) => n.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

const ESTADO_LABEL: Record<string, { txt: string; cls: string }> = {
    borrador: { txt: 'Borrador', cls: 'gray' },
    enviado: { txt: 'Enviado a IM', cls: 'green' },
    facturado: { txt: 'Facturado', cls: 'green' },
    anulado: { txt: 'Anulado', cls: 'gray' },
    error: { txt: 'Error', cls: 'red' },
    sin_respuesta: { txt: 'Sin respuesta ⚠️', cls: 'amber' },
};

export const PedidosApp = ({ onClose, clients = [] }: Props) => {
    const [mode, setMode] = useState<'nuevo' | 'lista'>('nuevo');

    // ── Maestro de clientes (prop + lookup completo) ────────────────────────
    const [fullClients, setFullClients] = useState<ClienteOpt[]>([]);
    useEffect(() => {
        fetch('/api/clientes/lookup', { headers: authHeaders() })
            .then(r => r.ok ? r.json() : null)
            .then(d => {
                const arr = d?.clientes ?? d?.results ?? [];
                if (Array.isArray(arr)) setFullClients(arr.map((c: any) => ({
                    cod: String(c.cod_cliente ?? c.cod), name: String(c.razon_social ?? c.nombre ?? c.name ?? ''), localidad: c.localidad ?? '',
                })));
            })
            .catch(() => { /* usamos el prop */ });
    }, []);
    const clientList = useMemo(() => {
        const m = new Map<string, ClienteOpt>();
        clients.forEach(c => m.set(String(c.cod), c));
        fullClients.forEach(c => m.set(String(c.cod), c));
        return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
    }, [clients, fullClients]);

    // ── Estado del pedido ───────────────────────────────────────────────────
    const [step, setStep] = useState<Step>('cliente');
    const [cliente, setCliente] = useState<ClienteOpt | null>(null);
    // Lista con la que arranca cada renglon nuevo: la que el cliente tiene en IM.
    // El vendedor la cambia por renglon si la cantidad lo amerita.
    const [listaCliente, setListaCliente] = useState<number>(LISTA_DEFECTO);
    const [credito, setCredito] = useState<Credito | null>(null);
    const [credLoading, setCredLoading] = useState(false);
    const [cart, setCart] = useState<CartItem[]>([]);
    const [obs, setObs] = useState('');
    const [clienteSearch, setClienteSearch] = useState('');

    const idempotencyKey = useRef<string>(crypto.randomUUID());

    // ── Buscador de clientes ────────────────────────────────────────────────
    const clientesFiltrados = useMemo(() => {
        const t = clienteSearch.trim().toLowerCase();
        if (!t) return clientList.slice(0, 30);
        return clientList.filter(c => c.name.toLowerCase().includes(t) || c.cod.includes(t)).slice(0, 30);
    }, [clienteSearch, clientList]);

    async function elegirCliente(c: ClienteOpt) {
        setCliente(c); setStep('productos'); setCredito(null); setCredLoading(true);
        try {
            const r = await fetch(`/api/pedidos/credito/${c.cod}`, { headers: authHeaders() });
            const d = await r.json();
            if (d?.ok && d.credito) setCredito(d.credito);
        } catch { /* sin crédito, no bloquea */ }
        setCredLoading(false);
    }

    // ── Buscador de artículos ───────────────────────────────────────────────
    const [catQuery, setCatQuery] = useState('');
    const [catResults, setCatResults] = useState<CatItem[]>([]);
    const [catLoading, setCatLoading] = useState(false);
    useEffect(() => {
        if (step !== 'productos') return;
        const t = catQuery.trim();
        if (t.length < 2) { setCatResults([]); return; }
        setCatLoading(true);
        const ctrl = new AbortController();
        const timer = setTimeout(async () => {
            try {
                const r = await fetch(`/api/pedidos/catalogo?q=${encodeURIComponent(t)}`, { headers: authHeaders(), signal: ctrl.signal });
                const d = await r.json();
                if (d?.ok) setCatResults(d.articulos ?? []);
            } catch { /* abort/red */ }
            setCatLoading(false);
        }, 300);
        return () => { clearTimeout(timer); ctrl.abort(); };
    }, [catQuery, step]);

    async function agregarArticulo(a: CatItem) {
        if (cart.some(i => i.cod_articulo === a.cod_articulo)) return;
        // Precio de la lista del cliente (no el genérico del catálogo).
        let precio = a.precio_venta;
        let listaDelItem = listaCliente;
        try {
            const r = await fetch(`/api/pedidos/precio?cod_articulo=${a.cod_articulo}&cod_cliente=${cliente?.cod ?? ''}`, { headers: authHeaders() });
            const d = await r.json();
            if (d?.ok && d.precio?.precio_vta != null) precio = Number(d.precio.precio_vta);
            // el backend nos dice con que lista cotizo: esa es la del cliente
            if (d?.ok && Number(d.cod_lista) > 0) { listaDelItem = Number(d.cod_lista); setListaCliente(listaDelItem); }
        } catch { /* usa el genérico */ }
        setCart(c => [...c, { cod_articulo: a.cod_articulo, descripcion: a.descripcion, cantidad: 1, precio, cod_lista: listaDelItem }]);
        setCatQuery(''); setCatResults([]);
    }
    const setQty = (cod: number, q: number) => setCart(c => c.map(i => i.cod_articulo === cod ? { ...i, cantidad: Math.max(0.001, q) } : i));

    /** Cambiar la lista de un renglon: se re-pide el precio de ESA lista. */
    async function setLista(cod: number, codLista: number) {
        setCart(c => c.map(i => i.cod_articulo === cod ? { ...i, cod_lista: codLista } : i));
        try {
            const r = await fetch(`/api/pedidos/precio?cod_articulo=${cod}&cod_lista=${codLista}`, { headers: authHeaders() });
            const d = await r.json();
            if (d?.ok && d.precio?.precio_vta != null) {
                const nuevo = Number(d.precio.precio_vta);
                setCart(c => c.map(i => i.cod_articulo === cod ? { ...i, precio: nuevo } : i));
            }
        } catch { /* si falla, queda el precio anterior y el backend recalcula al enviar */ }
    }
    const quitar = (cod: number) => setCart(c => c.filter(i => i.cod_articulo !== cod));
    const total = useMemo(() => cart.reduce((a, i) => a + i.cantidad * i.precio, 0), [cart]);

    // ── Control de listas ───────────────────────────────────────────────────
    // Se corre EN VIVO mientras arma el carrito: avisar recién al confirmar llega tarde,
    // ahí ya cargó todo el pedido y tendría que volver renglón por renglón.
    const [control, setControl] = useState<ControlListas | null>(null);
    useEffect(() => {
        if (!cart.length) { setControl(null); return; }
        const ctrl = new AbortController();
        const timer = setTimeout(async () => {
            try {
                const r = await fetch('/api/pedidos/validar', {
                    method: 'POST', signal: ctrl.signal,
                    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items: cart.map(i => ({ cod_articulo: i.cod_articulo, cantidad: i.cantidad, cod_lista: i.cod_lista })) }),
                });
                const d = await r.json();
                if (d?.ok) setControl(d);
            } catch { /* si falla el control el pedido sigue igual: avisa, no frena */ }
        }, 400);
        return () => { clearTimeout(timer); ctrl.abort(); };
    }, [cart]);
    const avisoDe = (cod: number) => control?.avisos?.find(a => a.cod_articulo === cod && a.mensaje);
    const faltanBultos = control ? Math.max(0, 10 - control.bultos) : 0;

    // ── Confirmar ───────────────────────────────────────────────────────────
    const [enviando, setEnviando] = useState(false);
    const [resultado, setResultado] = useState<{ ok: boolean; numero?: number | null; msg: string; warn?: boolean } | null>(null);

    async function confirmar() {
        if (!cliente || !cart.length) return;
        setEnviando(true); setResultado(null);
        try {
            const r = await fetch('/api/pedidos', {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cod_cliente: Number(cliente.cod),
                    observaciones: obs || undefined,
                    idempotency_key: idempotencyKey.current,
                    items: cart.map(i => ({ cod_articulo: i.cod_articulo, cantidad: i.cantidad, cod_lista: i.cod_lista })),
                }),
            });
            const d = await r.json();
            if (r.ok && d?.ok) {
                setResultado({ ok: true, numero: d.pedido?.im_numero ?? null, msg: d.dry_run ? 'Guardado (DRY-RUN, no se envió a IM)' : 'Pedido enviado a InfoManager' });
                setStep('listo');
            } else if (r.status === 202 || d?.sin_respuesta) {
                setResultado({ ok: false, warn: true, msg: d?.error ?? 'IM no respondió — revisá antes de reintentar' });
                setStep('listo');
            } else {
                setResultado({ ok: false, msg: d?.error ?? 'No se pudo crear el pedido' });
                setStep('listo');
            }
        } catch (e: any) {
            setResultado({ ok: false, msg: e?.message ?? 'Error de red' });
            setStep('listo');
        }
        setEnviando(false);
    }

    function nuevoPedido() {
        setStep('cliente'); setCliente(null); setCredito(null); setCart([]); setObs(''); setListaCliente(LISTA_DEFECTO);
        setClienteSearch(''); setCatQuery(''); setCatResults([]); setResultado(null);
        idempotencyKey.current = crypto.randomUUID();
    }

    // ── Lista de pedidos ────────────────────────────────────────────────────
    const [pedidos, setPedidos] = useState<Pedido[]>([]);
    const [pedLoading, setPedLoading] = useState(false);
    useEffect(() => {
        if (mode !== 'lista') return;
        setPedLoading(true);
        fetch('/api/pedidos', { headers: authHeaders() })
            .then(r => r.json()).then(d => setPedidos(d?.pedidos ?? [])).catch(() => {}).finally(() => setPedLoading(false));
    }, [mode, resultado]);

    // ── Semáforo de crédito ─────────────────────────────────────────────────
    const credColor = credito
        ? (credito.disponible <= 0 || credito.saldo < 0 ? 'red' : credito.disponible < (Math.abs(credito.saldo) * 0.1) ? 'amber' : 'green')
        : 'gray';

    return (
        <div className="ped-overlay" onClick={onClose}>
            <div className="ped-modal" onClick={e => e.stopPropagation()}>
                <header className="ped-header">
                    <div className="ped-title"><ShoppingCart size={20} /> Pedidos</div>
                    <div className="ped-tabs">
                        <button className={mode === 'nuevo' ? 'on' : ''} onClick={() => setMode('nuevo')}>Nuevo</button>
                        <button className={mode === 'lista' ? 'on' : ''} onClick={() => setMode('lista')}>Mis pedidos</button>
                    </div>
                    <button className="ped-close" onClick={onClose} aria-label="Cerrar"><X size={20} /></button>
                </header>

                {mode === 'lista' && (
                    <div className="ped-body">
                        {pedLoading && <div className="ped-empty"><Loader2 className="spin" size={20} /> Cargando…</div>}
                        {!pedLoading && !pedidos.length && <div className="ped-empty">Todavía no cargaste pedidos.</div>}
                        {pedidos.map(p => {
                            const e = ESTADO_LABEL[p.estado] ?? { txt: p.estado, cls: 'gray' };
                            return (
                                <div key={p.id} className="ped-row">
                                    <div>
                                        <div className="ped-row-cli">{p.cliente_nombre ?? `Cliente ${p.cod_cliente}`}</div>
                                        <div className="ped-row-sub">{new Date(p.created_at).toLocaleDateString('es-AR')} · {money(p.total_estimado)}{p.im_numero ? ` · Nº ${p.im_numero}` : ''}</div>
                                    </div>
                                    <span className={`ped-chip ${e.cls}`}>{e.txt}</span>
                                </div>
                            );
                        })}
                    </div>
                )}

                {mode === 'nuevo' && step === 'cliente' && (
                    <div className="ped-body">
                        <div className="ped-search">
                            <Search size={18} />
                            <input autoFocus placeholder="Buscar cliente…" value={clienteSearch} onChange={e => setClienteSearch(e.target.value)} />
                        </div>
                        {clientesFiltrados.map(c => (
                            <button key={c.cod} className="ped-cli-opt" onClick={() => elegirCliente(c)}>
                                <User size={16} />
                                <div><div className="ped-cli-name">{c.name}</div>{c.localidad && <div className="ped-cli-loc">{c.localidad}</div>}</div>
                            </button>
                        ))}
                        {!clientesFiltrados.length && <div className="ped-empty">Sin resultados.</div>}
                    </div>
                )}

                {mode === 'nuevo' && step === 'productos' && cliente && (
                    <>
                        <div className="ped-body">
                            {/* Cliente + crédito */}
                            <div className="ped-cliente-box">
                                <button className="ped-back" onClick={() => setStep('cliente')}><ArrowLeft size={16} /></button>
                                <div className="ped-cliente-info">
                                    <div className="ped-cli-name">{cliente.name}</div>
                                    <div className={`ped-credito ${credColor}`}>
                                        <Wallet size={14} />
                                        {credLoading ? 'Consultando crédito…' : credito
                                            ? <>Saldo {money(credito.saldo)} · Cupo {money(credito.disponible)}</>
                                            : 'Sin datos de crédito'}
                                    </div>
                                </div>
                            </div>

                            {/* Buscador de productos */}
                            <div className="ped-search">
                                <PackageSearch size={18} />
                                <input placeholder="Buscar producto…" value={catQuery} onChange={e => setCatQuery(e.target.value)} />
                                {catLoading && <Loader2 className="spin" size={16} />}
                            </div>
                            {catResults.map(a => (
                                <button key={a.cod_articulo} className="ped-cat-opt" onClick={() => agregarArticulo(a)}>
                                    <Plus size={16} />
                                    <div className="ped-cat-desc">{a.descripcion}</div>
                                    <div className="ped-cat-precio">{money(a.precio_venta)}</div>
                                </button>
                            ))}

                            {/* Carrito */}
                            {cart.length > 0 && <div className="ped-cart-title">Pedido ({cart.length})</div>}

                            {/* Cuántos bultos lleva y cuánto le falta para la promo general.
                                Le sirve al vendedor para cerrar la venta, no solo para no equivocarse. */}
                            {control && (
                                <div className={`ped-promo ${control.promo_general ? 'on' : ''}`}>
                                    <Package size={15} />
                                    {control.promo_general
                                        ? <span><b>{control.bultos} bultos</b> · promoción general activa: Lista 2 habilitada</span>
                                        : <span><b>{control.bultos} {control.bultos === 1 ? 'bulto' : 'bultos'}</b> · {faltanBultos} más para la Lista 2</span>}
                                </div>
                            )}

                            {cart.map(i => {
                                const av = avisoDe(i.cod_articulo);
                                return (
                                <div key={i.cod_articulo} className="ped-cart-item">
                                    <div className="ped-cart-desc">{i.descripcion}<span className="ped-cart-precio">{money(i.precio)} c/u</span></div>
                                    <div className="ped-qty">
                                        <button onClick={() => setQty(i.cod_articulo, i.cantidad - 1)}><Minus size={14} /></button>
                                        <input type="number" value={i.cantidad} onChange={e => setQty(i.cod_articulo, Number(e.target.value))} />
                                        <button onClick={() => setQty(i.cod_articulo, i.cantidad + 1)}><Plus size={14} /></button>
                                    </div>
                                    <select
                                        className={`ped-cart-lista${av ? ' alerta' : ''}`}
                                        value={i.cod_lista}
                                        onChange={e => setLista(i.cod_articulo, Number(e.target.value))}
                                        title="Lista de precios de este renglón"
                                    >
                                        {LISTAS.map(l => <option key={l.cod} value={l.cod}>{l.label}</option>)}
                                    </select>
                                    <div className="ped-cart-sub">{money(i.cantidad * i.precio)}</div>
                                    <button className="ped-cart-del" onClick={() => quitar(i.cod_articulo)}><Trash2 size={14} /></button>
                                    {av && av.lista_sugerida != null && (
                                        <div className={`ped-aviso ${av.severidad}`}>
                                            <AlertTriangle size={14} />
                                            <span>{av.mensaje}</span>
                                            {/* Botón y no :hover: las sucursales cargan desde el celular. */}
                                            <button onClick={() => setLista(i.cod_articulo, av.lista_sugerida!)}>
                                                Poner {NOMBRE_LISTA[av.lista_sugerida] ?? av.lista_sugerida}
                                            </button>
                                        </div>
                                    )}
                                </div>
                                );
                            })}

                            {cart.length > 0 && (
                                <textarea className="ped-obs" placeholder="Observaciones (opcional)" value={obs} onChange={e => setObs(e.target.value)} />
                            )}
                        </div>

                        <footer className="ped-footer">
                            <div className="ped-total">Total <b>{money(total)}</b><span className="ped-total-nota">IM recalcula al facturar</span></div>
                            <button className="ped-confirm" disabled={!cart.length || enviando} onClick={confirmar}>
                                {enviando ? <><Loader2 className="spin" size={18} /> Enviando…</> : <><Send size={18} /> Confirmar pedido</>}
                            </button>
                        </footer>
                    </>
                )}

                {mode === 'nuevo' && step === 'listo' && resultado && (
                    <div className="ped-body ped-result">
                        {resultado.ok
                            ? <CheckCircle2 size={54} className="ok" />
                            : resultado.warn ? <AlertCircle size={54} className="amber" /> : <Ban size={54} className="err" />}
                        <div className="ped-result-msg">
                            {resultado.ok
                                ? <>Pedido cargado{resultado.numero ? <> · <b>Nº {resultado.numero}</b></> : ''}</>
                                : resultado.msg}
                        </div>
                        {resultado.ok && <div className="ped-result-sub">{resultado.msg}. La oficina lo verá en InfoManager.</div>}
                        <div className="ped-result-actions">
                            <button className="ped-confirm" onClick={nuevoPedido}><Plus size={18} /> Otro pedido</button>
                            <button className="ped-secondary" onClick={onClose}>Cerrar</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
