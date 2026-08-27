import { useEffect, useMemo, useRef, useState } from 'react';
import {
    X, Search, User, ShoppingCart, Plus, Minus, Trash2, Send, Loader2,
    CheckCircle2, AlertCircle, ArrowLeft, PackageSearch, Wallet, Ban,
    Package, AlertTriangle, Pencil,
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
interface CartItem { cod_articulo: number; descripcion: string; cantidad: number; precio: number; cod_lista: number; descuento: number }

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
    /** Tope de descuento del renglón. 0 = no tiene descuentos habilitados. */
    descuento_max: number;
    /** Se pasó del tope: qué está mal y cuánto puede. */
    mensaje_descuento: string | null;
    /** Condición que el sistema no puede verificar (ej: que el pago sea contado). */
    nota_descuento: string | null;
}
interface ControlListas {
    bultos: number; promo_general: boolean; avisos: AvisoLista[];
    /** El backend no pudo evaluar las listas (IM caído, reglas sin cargar). Los números son 0
     *  de relleno: mostrarlos hace creer que faltan 10 bultos cuando en el carrito hay 40. */
    sin_control?: boolean;
}

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
    // id del pedido que se está editando (null = pedido nuevo). Editar reusa el mismo
    // wizard: para el vendedor es la misma pantalla, sólo cambia a dónde se manda al final.
    const [editando, setEditando] = useState<string | null>(null);

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
    // Sin esto, un IM caido se veia igual que "ese producto no existe": el vendedor cortaba
    // la venta y llamaba a la oficina. El backend ya redacta el 502, solo habia que mostrarlo.
    const [catError, setCatError] = useState<string | null>(null);
    // El buscador muestra sólo lo que hay en el depósito de casa central. Si una búsqueda
    // no encuentra nada, se ofrece ampliar a todo el catálogo: hay un puñado de artículos
    // que se facturan desde acá sin figurar en el depósito, y no poder cargarlos frenaría
    // una venta.
    const [catTodos, setCatTodos] = useState(false);
    useEffect(() => { setCatTodos(false); }, [catQuery]);
    useEffect(() => {
        if (step !== 'productos') return;
        const t = catQuery.trim();
        if (t.length < 2) { setCatResults([]); return; }
        setCatLoading(true);
        const ctrl = new AbortController();
        const timer = setTimeout(async () => {
            try {
                const r = await fetch(`/api/pedidos/catalogo?q=${encodeURIComponent(t)}${catTodos ? '&todos=1' : ''}`, { headers: authHeaders(), signal: ctrl.signal });
                const d = await r.json().catch(() => null);
                if (r.ok && d?.ok) { setCatResults(d.articulos ?? []); setCatError(null); }
                else { setCatResults([]); setCatError(d?.error ?? 'No se pudo consultar el catálogo de InfoManager.'); }
            } catch (e: any) {
                // El abort de la búsqueda anterior no es un error: sólo la red lo es.
                if (e?.name !== 'AbortError') { setCatResults([]); setCatError('Sin conexión: no pude consultar el catálogo.'); }
            }
            setCatLoading(false);
        }, 300);
        return () => { clearTimeout(timer); ctrl.abort(); };
    }, [catQuery, step, catTodos]);

    const [agregando, setAgregando] = useState<number | null>(null);
    async function agregarArticulo(a: CatItem) {
        // 🪤 El chequeo de duplicado estaba ACÁ, antes del await que va a buscar el precio a
        // IM. Como nada se renderizaba mientras tanto, dos toques seguidos leían el mismo
        // `cart` del closure, los dos pasaban, y el artículo entraba DOS VECES. Con dos
        // renglones del mismo código, setQty y setLista mueven los dos juntos: el pedido
        // salía con el doble de cantidad, y encima bultosDelPedido contaba doble, prendía la
        // promo general de más y APAGABA el bloqueo por margen. Ahora el chequeo va adentro
        // del updater funcional (ve el estado real) y el resultado muestra que trabaja.
        if (agregando != null) return;
        const yaEsta = cart.find(i => i.cod_articulo === a.cod_articulo);
        if (yaEsta) {
            // Ya está en el carrito: sumarle uno, en vez de no hacer absolutamente nada.
            setQty(a.cod_articulo, Math.floor(yaEsta.cantidad) + 1);
            setCatQuery(''); setCatResults([]);
            return;
        }
        setAgregando(a.cod_articulo);
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
        setCart(c => c.some(i => i.cod_articulo === a.cod_articulo)
            ? c
            : [...c, { cod_articulo: a.cod_articulo, descripcion: a.descripcion, cantidad: 1, precio, cod_lista: listaDelItem, descuento: 0 }]);
        setAgregando(null);
        setCatQuery(''); setCatResults([]);
    }
    const setQty = (cod: number, q: number) =>
        setCart(c => c.map(i => i.cod_articulo === cod ? { ...i, cantidad: q } : i));

    // 🪤 El input era type="number" y hacía Number(e.target.value) directo. Al borrar el
    // contenido para escribir otra cantidad, Number('') daba 0 y el mínimo lo dejaba en
    // 0,001: el campo quedaba trabado y había que borrar el renglón. Y escribiendo "1.5",
    // al pasar por "1." se perdía el punto. Ahora el texto se edita libre y recién se
    // normaliza al salir del campo. type="text" + inputMode="decimal" también evita los
    // spinners minúsculos y abre el teclado numérico en el celular, que es donde se usa.
    const [qtyTexto, setQtyTexto] = useState<Record<number, string>>({});
    function escribirQty(cod: number, txt: string) {
        if (!/^\d*[.,]?\d*$/.test(txt)) return;      // sólo números y un separador decimal
        setQtyTexto(q => ({ ...q, [cod]: txt }));
        const n = Number(txt.replace(',', '.'));
        if (txt !== '' && Number.isFinite(n) && n > 0) setQty(cod, n);
    }
    function cerrarQty(cod: number) {
        const txt = qtyTexto[cod];
        setQtyTexto(q => { const c = { ...q }; delete c[cod]; return c; });
        const n = Number(String(txt ?? '').replace(',', '.'));
        if (txt !== undefined && (!Number.isFinite(n) || n <= 0)) setQty(cod, 1);
    }

    /** Cambiar la lista de un renglon: se re-pide el precio de ESA lista. */
    async function setLista(cod: number, codLista: number) {
        setCart(c => c.map(i => i.cod_articulo === cod ? { ...i, cod_lista: codLista } : i));
        try {
            const r = await fetch(`/api/pedidos/precio?cod_articulo=${cod}&cod_lista=${codLista}`, { headers: authHeaders() });
            const d = await r.json();
            // El backend devuelve la lista que cotizó. Si el vendedor tocó L2 y después L4, la
            // respuesta de L2 puede llegar última y dejaba el precio de L2 con la etiqueta L4 —
            // y ese es justo el número que le canta al cliente por teléfono.
            if (d?.ok && d.precio?.precio_vta != null && Number(d.cod_lista) === codLista) {
                const nuevo = Number(d.precio.precio_vta);
                setCart(c => c.map(i => i.cod_articulo === cod ? { ...i, precio: nuevo } : i));
            }
        } catch { /* si falla, queda el precio anterior y el backend recalcula al enviar */ }
    }
    /** Descuento del renglón, 0 a 100. Se edita como texto (mismo motivo que la cantidad). */
    const [descTexto, setDescTexto] = useState<Record<number, string>>({});
    function escribirDesc(cod: number, txt: string) {
        if (!/^\d{0,3}([.,]\d{0,2})?$/.test(txt)) return;
        setDescTexto(q => ({ ...q, [cod]: txt }));
        const n = Math.min(Math.max(Number(txt.replace(',', '.')) || 0, 0), 100);
        setCart(c => c.map(i => i.cod_articulo === cod ? { ...i, descuento: n } : i));
    }
    function cerrarDesc(cod: number) {
        setDescTexto(q => { const c = { ...q }; delete c[cod]; return c; });
    }
    const quitar = (cod: number) => setCart(c => c.filter(i => i.cod_articulo !== cod));
    const subtotalDe = (i: CartItem) => i.cantidad * i.precio * (1 - (i.descuento || 0) / 100);
    const total = useMemo(() => cart.reduce((a, i) => a + subtotalDe(i), 0), [cart]);

    // ── Control de listas ───────────────────────────────────────────────────
    // Se corre EN VIVO mientras arma el carrito: avisar recién al confirmar llega tarde,
    // ahí ya cargó todo el pedido y tendría que volver renglón por renglón.
    const [control, setControl] = useState<ControlListas | null>(null);
    useEffect(() => { setMsgBloqueo(null); }, [cart]);
    useEffect(() => {
        if (!cart.length) { setControl(null); return; }
        const ctrl = new AbortController();
        const timer = setTimeout(async () => {
            try {
                const r = await fetch('/api/pedidos/validar', {
                    method: 'POST', signal: ctrl.signal,
                    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                    // 🪤 El descuento TIENE que ir acá. Sin él, el motor evalúa cada renglón
                    // con descuento 0 y nunca encuentra nada que avisar: el vendedor podía
                    // poner cualquier % y el control se quedaba mudo hasta el envío final.
                    body: JSON.stringify({ items: cart.map(i => ({ cod_articulo: i.cod_articulo, cantidad: i.cantidad, cod_lista: i.cod_lista, descuento_porc: i.descuento || 0 })) }),
                });
                const d = await r.json();
                if (d?.ok) setControl(d);
            } catch { /* si falla el control el pedido sigue igual: avisa, no frena */ }
        }, 400);
        return () => { clearTimeout(timer); ctrl.abort(); };
    }, [cart]);
    const avisoDe = (cod: number) => control?.avisos?.find(a => a.cod_articulo === cod && a.mensaje);
    const descDe = (cod: number) => control?.avisos?.find(a => a.cod_articulo === cod);
    const faltanBultos = control ? Math.max(0, 10 - control.bultos) : 0;
    // El control AVISA, no frena (Mati lo dio de baja el 27/08 mientras la parametrización
    // se sigue afinando: un falso positivo le bloquea una venta legítima al vendedor).
    // El backend tiene el flag PEDIDOS_BLOQUEAR_MARGEN para volver a prenderlo; si eso pasa,
    // el 422 llega igual y se muestra en el cartel de abajo.
    const bloqueos: AvisoLista[] = [];

    // ── Editar un pedido ya cargado ─────────────────────────────────────────
    const [abriendo, setAbriendo] = useState<string | null>(null);
    async function editarPedido(p: Pedido) {
        setAbriendo(p.id);
        try {
            const r = await fetch(`/api/pedidos/${p.id}`, { headers: authHeaders() });
            const d = await r.json();
            if (!r.ok || !d?.ok) { alert(d?.error ?? 'No se pudo abrir el pedido'); return; }
            setCart((d.items ?? []).map((i: any) => ({
                cod_articulo: Number(i.cod_articulo),
                descripcion: String(i.descripcion ?? `Artículo ${i.cod_articulo}`),
                cantidad: Number(i.cantidad),
                precio: Number(i.precio_unit),
                cod_lista: Number(i.cod_lista_precios) || LISTA_DEFECTO,
                descuento: Number(i.descuento_porc) || 0,
            })));
            setCliente({ cod: String(p.cod_cliente), name: p.cliente_nombre ?? `Cliente ${p.cod_cliente}` });
            setObs(d.pedido?.observaciones ?? '');
            setEditando(p.id);
            setResultado(null);
            setMode('nuevo');
            setStep('productos');
            setCredito(null); setCredLoading(true);
            try {
                const rc = await fetch(`/api/pedidos/credito/${p.cod_cliente}`, { headers: authHeaders() });
                const dc = await rc.json();
                if (dc?.ok && dc.credito) setCredito(dc.credito);
            } catch { /* sin crédito, no bloquea */ }
            setCredLoading(false);
        } catch (e: any) {
            alert(e?.message ?? 'Error de red');
        } finally {
            setAbriendo(null);
        }
    }
    /** Facturado o anulado ya no se toca. */
    const editable = (p: Pedido) => p.estado !== 'facturado' && p.estado !== 'anulado' && p.estado !== 'sin_respuesta';

    const [anulando, setAnulando] = useState<string | null>(null);
    async function anularPedido(p: Pedido) {
        const quien = p.im_numero ? `el presupuesto Nº ${p.im_numero}` : 'el pedido';
        if (!confirm(`¿Anular ${quien} de ${p.cliente_nombre ?? `cliente ${p.cod_cliente}`}?

Se anula también en InfoManager. No se puede deshacer.`)) return;
        setAnulando(p.id);
        try {
            const r = await fetch(`/api/pedidos/${p.id}/anular`, { method: 'POST', headers: authHeaders() });
            const d = await r.json();
            if (!r.ok || !d?.ok) { alert(d?.error ?? 'No se pudo anular'); return; }
            if (d.ya_no_estaba) alert('El presupuesto ya no estaba en InfoManager (lo borraron desde ahí). El pedido quedó marcado como anulado.');
            setPedidos(ps => ps.map(x => x.id === p.id ? { ...x, estado: 'anulado' } : x));
        } catch (e: any) {
            alert(e?.message ?? 'Error de red');
        } finally {
            setAnulando(null);
        }
    }

    // ── Confirmar ───────────────────────────────────────────────────────────
    const [enviando, setEnviando] = useState(false);
    // Motivo por el que el backend rechazó el último envío. Se limpia al tocar el carrito.
    const [msgBloqueo, setMsgBloqueo] = useState<string | null>(null);
    const [resultado, setResultado] = useState<{ ok: boolean; numero?: number | null; msg: string; warn?: boolean } | null>(null);

    async function confirmar() {
        if (!cliente || !cart.length) return;
        setEnviando(true); setResultado(null); setMsgBloqueo(null);
        try {
            const items = cart.map(i => ({ cod_articulo: i.cod_articulo, cantidad: i.cantidad, cod_lista: i.cod_lista, descuento_porc: i.descuento || 0 }));
            const r = editando
                ? await fetch(`/api/pedidos/${editando}`, {
                    method: 'PUT',
                    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ observaciones: obs || undefined, items }),
                })
                : await fetch('/api/pedidos', {
                    method: 'POST',
                    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        cod_cliente: Number(cliente.cod),
                        observaciones: obs || undefined,
                        idempotency_key: idempotencyKey.current,
                        items,
                    }),
                });
            const d = await r.json();
            if (r.ok && d?.ok) {
                setResultado({
                    ok: true,
                    warn: !!d.aviso,
                    numero: d.pedido?.im_numero ?? null,
                    // El backend manda `aviso` cuando el pedido SI entro a IM pero no se pudo
                    // guardar de este lado: es un exito a medias y el vendedor tiene que saberlo.
                    msg: d.aviso ? String(d.aviso)
                        : !editando
                        ? (d.dry_run ? 'Guardado (DRY-RUN, no se envió a IM)' : 'Pedido enviado a InfoManager')
                        : d.numero_cambio
                            ? 'Pedido modificado. Como cambiaron los productos, InfoManager le dio un número nuevo y anuló el anterior.'
                            : 'Pedido modificado en InfoManager.',
                });
                setStep('listo');
            } else if (r.status === 202 || d?.sin_respuesta) {
                setResultado({ ok: false, warn: true, msg: d?.error ?? 'IM no respondió — revisá antes de reintentar' });
                setStep('listo');
            } else if (r.status === 422 && d?.bloqueado) {
                // 🪤 Antes esto hacía `return` sin mostrar nada, asumiendo que el renglón ya
                // estaba marcado en rojo. Falso: si estuviera en rojo el botón estaría
                // deshabilitado y este POST nunca habría salido. El caso determinista es el
                // artículo sin precio en la lista elegida — el control en vivo no mira
                // precios, así que nunca lo marca, y el vendedor quedaba trabado tocando
                // Confirmar sin que pasara nada. El backend ya redactó el mensaje: usarlo.
                setMsgBloqueo(d?.error ?? 'No se pudo enviar el pedido. Revisá los renglones marcados.');
                if (Array.isArray(d?.avisos) && d.avisos.length) {
                    setControl(c => ({ bultos: c?.bultos ?? 0, promo_general: c?.promo_general ?? false, avisos: d.avisos }));
                }
                setEnviando(false);
                return;
            } else {
                setResultado({ ok: false, msg: d?.error ?? 'No se pudo crear el pedido' });
                setStep('listo');
            }
        } catch {
            // Si la red se corta DESPUES de que salio el POST, el pedido pudo haber entrado a
            // IM igual. "Error de red" a secas invita a cargarlo de nuevo => presupuesto
            // duplicado. El backend distingue este caso con un 202; el catch no puede, asi que
            // avisa en ambar en vez de dar por fallado.
            setResultado({ ok: false, warn: true, msg: 'Se cortó la conexión y no se sabe si el pedido entró. Fijate en «Mis pedidos» antes de cargarlo de nuevo.' });
            setStep('listo');
        }
        setEnviando(false);
    }

    function nuevoPedido() {
        setStep('cliente'); setCliente(null); setCredito(null); setCart([]); setObs(''); setListaCliente(LISTA_DEFECTO);
        setClienteSearch(''); setCatQuery(''); setCatResults([]); setResultado(null); setEditando(null);
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
        /* 🪤 El overlay cerraba con cualquier tap. El modal mide 92vh y va pegado abajo, así
           que arriba quedan ~65px de overlay vivo: un toque ahí (acomodar el celular, cerrar
           el teclado) desmontaba todo y se perdía el pedido entero, sin confirmación.
           RecibosApp, el otro modal de carga, nunca tuvo este handler. */
        <div className="ped-overlay" onClick={() => { if (!cart.length && !enviando) onClose(); }}>
            <div className="ped-modal" onClick={e => e.stopPropagation()}>
                <header className="ped-header">
                    <div className="ped-title"><ShoppingCart size={20} /> Pedidos</div>
                    <div className="ped-tabs">
                        <button className={mode === 'nuevo' ? 'on' : ''} onClick={() => setMode('nuevo')}>Nuevo</button>
                        <button className={mode === 'lista' ? 'on' : ''} onClick={() => setMode('lista')}>Mis pedidos</button>
                    </div>
                    <button className="ped-close" disabled={enviando} onClick={onClose} aria-label="Cerrar"><X size={20} /></button>
                </header>

                {mode === 'lista' && (
                    <div className="ped-body">
                        {pedLoading && <div className="ped-empty"><Loader2 className="spin" size={20} /> Cargando…</div>}
                        {!pedLoading && !pedidos.length && <div className="ped-empty">Todavía no cargaste pedidos.</div>}
                        {pedidos.map(p => {
                            const e = ESTADO_LABEL[p.estado] ?? { txt: p.estado, cls: 'gray' };
                            return (
                                <div key={p.id} className="ped-row">
                                    <div className="ped-row-info">
                                        <div className="ped-row-cli">{p.cliente_nombre ?? `Cliente ${p.cod_cliente}`}</div>
                                        <div className="ped-row-sub">{new Date(p.created_at).toLocaleDateString('es-AR')} · {money(p.total_estimado)}{p.im_numero ? ` · Nº ${p.im_numero}` : ''}</div>
                                    </div>
                                    <span className={`ped-chip ${e.cls}`}>{e.txt}</span>
                                    {editable(p) && (
                                        <div className="ped-row-acciones">
                                            <button className="ped-editar" disabled={abriendo === p.id || anulando === p.id} onClick={() => editarPedido(p)}>
                                                {abriendo === p.id ? <Loader2 className="spin" size={14} /> : <Pencil size={14} />}
                                                Editar
                                            </button>
                                            <button className="ped-editar ped-anular" disabled={anulando === p.id || abriendo === p.id} onClick={() => anularPedido(p)}>
                                                {anulando === p.id ? <Loader2 className="spin" size={14} /> : <Ban size={14} />}
                                                Anular
                                            </button>
                                        </div>
                                    )}
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
                            {editando && (
                                <div className="ped-editando">
                                    <Pencil size={14} />
                                    <span>Estás editando un pedido ya cargado. Al confirmar se actualiza en InfoManager.</span>
                                </div>
                            )}
                            <div className="ped-cliente-box">
                                {/* Al editar no se puede cambiar de cliente: InfoManager no lo permite
                                    sobre un presupuesto existente. Habría que anularlo y cargarlo de nuevo. */}
                                {!editando && <button className="ped-back" onClick={() => setStep('cliente')}><ArrowLeft size={16} /></button>}
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
                                <button key={a.cod_articulo} className="ped-cat-opt" disabled={agregando != null}
                                    onClick={() => agregarArticulo(a)}>
                                    {agregando === a.cod_articulo ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
                                    <div className="ped-cat-desc">{a.descripcion}</div>
                                    <div className="ped-cat-precio">{money(a.precio_venta)}</div>
                                </button>
                            ))}
                            {catError && !catLoading && (
                                <div className="ped-sin-resultados error">
                                    <AlertTriangle size={15} />
                                    <span>{catError} No quiere decir que el producto no exista: probá de nuevo en un momento.</span>
                                    <button onClick={() => setCatQuery(q => q + ' ')}>Reintentar</button>
                                </div>
                            )}
                            {!catError && catQuery.trim().length >= 2 && !catLoading && !catResults.length && (
                                <div className="ped-sin-resultados">
                                    {catTodos
                                        ? <span>No hay ningún producto que coincida con «{catQuery.trim()}».</span>
                                        : <>
                                            <span>No hay productos de casa central que coincidan.</span>
                                            <button onClick={() => setCatTodos(true)}>Buscar en todo el catálogo</button>
                                        </>}
                                </div>
                            )}
                            {catTodos && catResults.length > 0 && (
                                <div className="ped-sin-resultados"><span>Mostrando también productos de las sucursales.</span></div>
                            )}

                            {/* Carrito */}
                            {cart.length > 0 && <div className="ped-cart-title">Pedido ({cart.length})</div>}

                            {/* Cuántos bultos lleva y cuánto le falta para la promo general.
                                Le sirve al vendedor para cerrar la venta, no solo para no equivocarse. */}
                            {control?.sin_control && (
                                <div className="ped-promo aviso">
                                    <AlertTriangle size={15} />
                                    <span>No pude chequear las listas en este momento. Revisá vos el pedido antes de enviarlo.</span>
                                </div>
                            )}
                            {control && !control.sin_control && (
                                <div className={`ped-promo ${control.promo_general ? 'on' : ''}`}>
                                    <Package size={15} />
                                    {control.promo_general
                                        ? <span><b>{control.bultos} bultos</b> · promoción general activa: Lista 2 habilitada</span>
                                        : <span><b>{control.bultos} {control.bultos === 1 ? 'bulto' : 'bultos'}</b> · {faltanBultos} más para la Lista 2</span>}
                                </div>
                            )}

                            {cart.map(i => {
                                const av = avisoDe(i.cod_articulo);
                                const dsc = descDe(i.cod_articulo);
                                return (
                                <div key={i.cod_articulo} className="ped-cart-item">
                                    <div className="ped-cart-desc">{i.descripcion}<span className="ped-cart-precio">{money(i.precio)} c/u</span></div>
                                    <div className="ped-qty">
                                        <button aria-label="Restar uno" disabled={i.cantidad <= 1}
                                            onClick={() => setQty(i.cod_articulo, Math.max(1, Math.round(i.cantidad) - 1))}><Minus size={16} /></button>
                                        <input
                                            type="text" inputMode="decimal" aria-label={`Cantidad de ${i.descripcion}`}
                                            value={qtyTexto[i.cod_articulo] ?? String(i.cantidad)}
                                            onChange={e => escribirQty(i.cod_articulo, e.target.value)}
                                            onFocus={e => e.currentTarget.select()}
                                            onBlur={() => cerrarQty(i.cod_articulo)}
                                        />
                                        <button aria-label="Sumar uno"
                                            onClick={() => setQty(i.cod_articulo, Math.floor(i.cantidad) + 1)}><Plus size={16} /></button>
                                    </div>
                                    <select
                                        className={`ped-cart-lista${av ? ' alerta' : ''}`}
                                        value={i.cod_lista}
                                        onChange={e => setLista(i.cod_articulo, Number(e.target.value))}
                                        title="Lista de precios de este renglón"
                                    >
                                        {LISTAS.map(l => <option key={l.cod} value={l.cod}>{l.label}</option>)}
                                    </select>
                                    <label className={`ped-desc${dsc?.mensaje_descuento ? ' alerta' : ''}`}
                                        title={dsc?.mensaje_descuento ?? (dsc && dsc.descuento_max > 0 ? `Hasta ${dsc.descuento_max}%` : 'Descuento de este renglón')}>
                                        <input
                                            type="text" inputMode="decimal" placeholder="0"
                                            aria-label={`Descuento en porcentaje de ${i.descripcion}`}
                                            value={descTexto[i.cod_articulo] ?? (i.descuento ? String(i.descuento) : '')}
                                            onChange={e => escribirDesc(i.cod_articulo, e.target.value)}
                                            onFocus={e => e.currentTarget.select()}
                                            onBlur={() => cerrarDesc(i.cod_articulo)}
                                        />
                                        <span>%</span>
                                    </label>
                                    <div className="ped-cart-sub">
                                        {money(subtotalDe(i))}
                                        {i.descuento > 0 && <span className="ped-cart-tachado">{money(i.cantidad * i.precio)}</span>}
                                    </div>
                                    <button className="ped-cart-del" onClick={() => quitar(i.cod_articulo)}><Trash2 size={14} /></button>
                                    {dsc?.mensaje_descuento && (
                                        <div className="ped-aviso margen">
                                            <AlertTriangle size={14} />
                                            <span>{dsc.mensaje_descuento}</span>
                                            {dsc.descuento_max > 0 && (
                                                <button onClick={() => escribirDesc(i.cod_articulo, String(dsc.descuento_max))}>
                                                    Poner {dsc.descuento_max}%
                                                </button>
                                            )}
                                            {dsc.descuento_max === 0 && (
                                                <button onClick={() => escribirDesc(i.cod_articulo, '')}>Sacar</button>
                                            )}
                                        </div>
                                    )}
                                    {dsc?.nota_descuento && !dsc.mensaje_descuento && (
                                        <div className="ped-aviso nota">
                                            <AlertCircle size={14} />
                                            <span>{dsc.nota_descuento}</span>
                                        </div>
                                    )}
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
                            {msgBloqueo && (
                                <div className="ped-bloqueo">
                                    <AlertTriangle size={16} />
                                    <span>{msgBloqueo}</span>
                                </div>
                            )}
                            {bloqueos.length > 0 && (
                                <div className="ped-bloqueo">
                                    <AlertTriangle size={16} />
                                    {bloqueos.length === 1
                                        ? <span>Corregí la lista del renglón marcado en rojo para poder enviar el pedido.</span>
                                        : <span>Corregí los <b>{bloqueos.length} renglones</b> marcados en rojo para poder enviar el pedido.</span>}
                                </div>
                            )}
                            <div className="ped-footer-row">
                                <div className="ped-total">Total <b>{money(total)}</b><span className="ped-total-nota">IM recalcula al facturar</span></div>
                                <button className="ped-confirm" disabled={!cart.length || enviando || bloqueos.length > 0} onClick={confirmar}>
                                        {enviando ? <><Loader2 className="spin" size={18} /> Enviando…</> : <><Send size={18} /> {editando ? 'Guardar cambios' : 'Confirmar pedido'}</>}
                                </button>
                            </div>
                        </footer>
                    </>
                )}

                {mode === 'nuevo' && step === 'listo' && resultado && (
                    <div className="ped-body ped-result">
                        {/* `warn` gana sobre `ok`: un exito a medias (entro a IM pero no se guardo
                            de este lado) no puede mostrarse con el tilde verde y "Pedido cargado". */}
                        {resultado.warn
                            ? <AlertCircle size={54} className="amber" />
                            : resultado.ok ? <CheckCircle2 size={54} className="ok" /> : <Ban size={54} className="err" />}
                        <div className="ped-result-msg">
                            {resultado.ok && !resultado.warn
                                ? <>Pedido cargado{resultado.numero ? <> · <b>Nº {resultado.numero}</b></> : ''}</>
                                : resultado.msg}
                        </div>
                        {resultado.ok && !resultado.warn && <div className="ped-result-sub">{resultado.msg}. La oficina lo verá en InfoManager.</div>}
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
