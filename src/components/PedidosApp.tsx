import { useEffect, useMemo, useRef, useState } from 'react';
import {
    X, Search, User, ShoppingCart, Plus, Minus, Trash2, Send, Loader2,
    CheckCircle2, AlertCircle, ArrowLeft, PackageSearch, Wallet, Ban,
    Package, AlertTriangle, Pencil, ChevronRight,
} from 'lucide-react';
import { authHeaders } from '../utils/auth';
import { buscarClientes } from '../utils/buscarClientes';
import './PedidosApp.css';

interface Props {
    onClose: () => void;
    clients?: Array<{ cod: string; name: string; localidad?: string }>;
}

interface ClienteOpt {
    cod: string; name: string; localidad?: string;
    /** Lista de precios del cliente en IM. Con la que cotiza el buscador. */
    cod_lista?: number;
}
interface Credito { saldo: number; disponible: number; control_margen_venta: string }
/**
 * Un resultado del buscador. `precio_venta` es null cuando el artículo no tiene precio en la
 * lista del cliente: null y 0 NO son lo mismo, y mostrar $0 fue justo el problema que reportó
 * Mati el 27/08 (el catálogo de IM trae ese campo en cero para el 31% de los artículos).
 */
interface CatItem { cod_articulo: number; descripcion: string; precio_venta: number | null }
/**
 * Un renglón del pedido.
 *
 * 🪤 `uid` es la identidad del RENGLÓN, y no se confunde con `cod_articulo`. El mismo
 * producto puede ir en dos renglones (Mati 27/08: "que cada vendedor pueda cargar el mismo
 * artículo en renglones distintos" — típicamente con distinta lista). Cuando la identidad era
 * el código, borrar uno borraba los dos, y la cantidad, la lista y el descuento se movían
 * juntos. `cod_articulo` queda sólo para hablar con InfoManager.
 */
interface CartItem {
    uid: string;
    cod_articulo: number; descripcion: string; cantidad: number; precio: number;
    cod_lista: number; descuento: number;
}

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
    /** Posición del renglón en el pedido: el mismo artículo puede estar dos veces. */
    idx: number;
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
    /**
     * Qué carrito produjo estos avisos (los uid de los renglones, en orden).
     *
     * 🪤 Los avisos se emparejan con los renglones POR POSICIÓN. Entre que el vendedor toca
     * el carrito y vuelve la respuesta pasan 400 ms de debounce más la ida a IM, y en ese
     * rato los avisos viejos quedan corridos: si borró un renglón del medio, cada fila de
     * abajo muestra el cartel del producto ANTERIOR — y el botón «Poner L2» le cambia la
     * lista al renglón equivocado de un toque. Mientras la firma no coincida, no se muestra
     * ninguno: es preferible un instante sin carteles que un cartel mintiendo.
     */
    firma?: string;
    /** El backend no pudo evaluar las listas (IM caído, reglas sin cargar). Los números son 0
     *  de relleno: mostrarlos hace creer que faltan 10 bultos cuando en el carrito hay 40. */
    sin_control?: boolean;
}

/** Un renglón tal como quedó guardado. Es lo que devuelve GET /api/pedidos/:id. */
interface ItemGuardado {
    cod_articulo: number; descripcion: string | null; cantidad: number;
    precio_unit: number; cod_lista_precios: number | null; descuento_porc: number | null;
    subtotal: number; aviso_lista: string | null;
}

interface Pedido {
    id: string; cod_cliente: number; cliente_nombre: string | null; estado: string;
    im_numero: number | null; total_estimado: number; created_at: string;
    /** Problema que quedó pendiente de resolver a mano en IM. Ver el badge "Revisar". */
    im_error?: string | null;
}

type Step = 'cliente' | 'productos' | 'listo';

const money = (n: number) => n.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

const ESTADO_LABEL: Record<string, { txt: string; cls: string }> = {
    borrador: { txt: 'Borrador', cls: 'gray' },
    enviado: { txt: 'Enviado a IM', cls: 'green' },
    // Verde igual que 'enviado' se leía como "todo bien, seguí": es el estado CERRADO, el
    // único donde el vendedor no puede hacer nada. Va con su propio color y con el candado.
    facturado: { txt: 'Facturado 🔒', cls: 'cerrado' },
    anulado: { txt: 'Anulado', cls: 'gray' },
    error: { txt: 'Error', cls: 'red' },
    sin_respuesta: { txt: 'Sin respuesta ⚠️', cls: 'amber' },
};

export const PedidosApp = ({ onClose, clients = [] }: Props) => {
    const [mode, setMode] = useState<'nuevo' | 'lista'>('nuevo');

    // ── Maestro de clientes (prop + lookup completo) ────────────────────────
    // 🪤 El prop `clients` NO es el maestro de clientes: VendorShell lo arma con `clientsAgg`,
    // que es la lista de DEUDORES de cobranzas (saldo > $2.000). Sirve para cobrar, no para
    // vender: el cliente al día, el que paga contado y el cliente nuevo no están ahí. Por eso
    // el maestro real (este lookup, ya filtrado por vendedor en el backend) es obligatorio y
    // no un adorno — si falla, se avisa en vez de dejar una lista muda y recortada.
    const [fullClients, setFullClients] = useState<ClienteOpt[]>([]);
    const [cliError, setCliError] = useState<string | null>(null);
    const [cliLoading, setCliLoading] = useState(true);
    useEffect(() => {
        let vivo = true;
        fetch('/api/clientes/lookup', { headers: authHeaders() })
            .then(async r => ({ ok: r.ok, d: await r.json().catch(() => null) }))
            .then(({ ok, d }) => {
                if (!vivo) return;
                // 🪤 El endpoint responde { ok, items }. Acá se leía `d.clientes ?? d.results`,
                // que no existen: el array quedaba vacío SIEMPRE y nadie se enteraba.
                const arr = d?.items ?? d?.clientes ?? d?.results ?? null;
                if (!ok || !Array.isArray(arr)) {
                    setCliError(d?.error ?? 'No se pudo cargar el listado de clientes.');
                    return;
                }
                if (d?.sin_vendedor) {
                    setCliError('Tu usuario no tiene código de vendedor asignado, así que no se puede saber qué clientes son tuyos. Avisale a Matías.');
                    return;
                }
                setCliError(null);
                setFullClients(arr.map((c: any) => ({
                    cod: String(c.cod ?? c.cod_cliente), name: String(c.name ?? c.razon_social ?? c.nombre ?? ''),
                    localidad: c.localidad ?? '',
                    cod_lista: Number(c.cod_lista) > 0 ? Number(c.cod_lista) : undefined,
                })));
            })
            .catch(() => { if (vivo) setCliError('Sin conexión: no se pudo cargar el listado de clientes.'); })
            .finally(() => { if (vivo) setCliLoading(false); });
        return () => { vivo = false; };
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
    // El ranking y la normalización viven en utils/buscarClientes.ts, con tests: es lo que
    // falló el 27/08 y tiene que poder verificarse sin montar el componente.
    const { resultados: clientesFiltrados, deMas: clientesDeMas } =
        useMemo(() => buscarClientes(clientList, clienteSearch), [clienteSearch, clientList]);

    async function elegirCliente(c: ClienteOpt) {
        // 🪤 `listaCliente` arrancaba SIEMPRE en L1 y recién se corregía adentro de
        // agregarArticulo, con el primer producto. O sea que la primera búsqueda le mostraba
        // al vendedor precios de Lista 1 aunque el cliente fuera L3 — y ese es el número que
        // le canta por teléfono. Peor al volver atrás y elegir otro cliente: arrastraba la
        // lista del ANTERIOR. El maestro ya trae la lista de cada cliente.
        setListaCliente(c.cod_lista ?? LISTA_DEFECTO);
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
    /** false = no se pudo consultar la lista de precios, no que los artículos no tengan. */
    const [hayPrecios, setHayPrecios] = useState(true);
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
                const r = await fetch(`/api/pedidos/catalogo?q=${encodeURIComponent(t)}&cod_lista=${listaCliente}${catTodos ? '&todos=1' : ''}`, { headers: authHeaders(), signal: ctrl.signal });
                const d = await r.json().catch(() => null);
                if (r.ok && d?.ok) { setCatResults(d.articulos ?? []); setCatError(null); setHayPrecios(d.hay_precios !== false); }
                else { setCatResults([]); setCatError(d?.error ?? 'No se pudo consultar el catálogo de InfoManager.'); }
            } catch (e: any) {
                // El abort de la búsqueda anterior no es un error: sólo la red lo es.
                if (e?.name !== 'AbortError') { setCatResults([]); setCatError('Sin conexión: no pude consultar el catálogo.'); }
            }
            setCatLoading(false);
        }, 300);
        return () => { clearTimeout(timer); ctrl.abort(); };
    }, [catQuery, step, catTodos, listaCliente]);

    const [agregando, setAgregando] = useState<number | null>(null);
    async function agregarArticulo(a: CatItem) {
        // 🪤 El chequeo de duplicado estaba ACÁ, antes del await que va a buscar el precio a
        // IM. Como nada se renderizaba mientras tanto, dos toques seguidos leían el mismo
        // `cart` del closure, los dos pasaban, y el artículo entraba DOS VECES. Con dos
        // renglones del mismo código, setQty y setLista mueven los dos juntos: el pedido
        // salía con el doble de cantidad, y encima bultosDelPedido contaba doble, prendía la
        // promo general de más y APAGABA el bloqueo por margen. Ahora el chequeo va adentro
        // del updater funcional (ve el estado real) y el resultado muestra que trabaja.
        // Sigue frenando el doble toque MIENTRAS busca el precio (ahí no se renderiza nada y
        // el vendedor no tiene forma de saber que ya lo tomó). Lo que ya NO se hace es
        // impedir el artículo repetido: cargarlo dos veces es algo que el vendedor quiere
        // poder hacer, y antes se le sumaba 1 a un renglón que ni estaba mirando.
        if (agregando != null) return;
        setAgregando(a.cod_articulo);
        // Precio de la lista del cliente. El del buscador ya viene de esa lista, pero se
        // recotiza igual porque es el número que se guarda en el renglón.
        let precio = a.precio_venta ?? 0;
        let listaDelItem = listaCliente;
        try {
            const r = await fetch(`/api/pedidos/precio?cod_articulo=${a.cod_articulo}&cod_cliente=${cliente?.cod ?? ''}`, { headers: authHeaders() });
            const d = await r.json();
            if (d?.ok && d.precio?.precio_vta != null) precio = Number(d.precio.precio_vta);
            // el backend nos dice con que lista cotizo: esa es la del cliente
            if (d?.ok && Number(d.cod_lista) > 0) { listaDelItem = Number(d.cod_lista); setListaCliente(listaDelItem); }
        } catch { /* usa el genérico */ }
        setCart(c => [...c, {
            uid: crypto.randomUUID(),
            cod_articulo: a.cod_articulo, descripcion: a.descripcion, cantidad: 1,
            precio, cod_lista: listaDelItem, descuento: 0,
        }]);
        setAgregando(null);
        setCatQuery(''); setCatResults([]);
    }
    const setQty = (uid: string, q: number) =>
        setCart(c => c.map(i => i.uid === uid ? { ...i, cantidad: q } : i));

    // 🪤 El input era type="number" y hacía Number(e.target.value) directo. Al borrar el
    // contenido para escribir otra cantidad, Number('') daba 0 y el mínimo lo dejaba en
    // 0,001: el campo quedaba trabado y había que borrar el renglón. Y escribiendo "1.5",
    // al pasar por "1." se perdía el punto. Ahora el texto se edita libre y recién se
    // normaliza al salir del campo. type="text" + inputMode="decimal" también evita los
    // spinners minúsculos y abre el teclado numérico en el celular, que es donde se usa.
    const [qtyTexto, setQtyTexto] = useState<Record<string, string>>({});
    function escribirQty(uid: string, txt: string) {
        if (!/^\d*[.,]?\d*$/.test(txt)) return;      // sólo números y un separador decimal
        setQtyTexto(q => ({ ...q, [uid]: txt }));
        const n = Number(txt.replace(',', '.'));
        if (txt !== '' && Number.isFinite(n) && n > 0) setQty(uid, n);
    }
    function cerrarQty(uid: string) {
        const txt = qtyTexto[uid];
        setQtyTexto(q => { const c = { ...q }; delete c[uid]; return c; });
        const n = Number(String(txt ?? '').replace(',', '.'));
        if (txt !== undefined && (!Number.isFinite(n) || n <= 0)) setQty(uid, 1);
    }

    /** Cambiar la lista de un renglon: se re-pide el precio de ESA lista. */
    async function setLista(uid: string, cod: number, codLista: number) {
        setCart(c => c.map(i => i.uid === uid ? { ...i, cod_lista: codLista } : i));
        try {
            const r = await fetch(`/api/pedidos/precio?cod_articulo=${cod}&cod_lista=${codLista}`, { headers: authHeaders() });
            const d = await r.json();
            // El backend devuelve la lista que cotizó. Si el vendedor tocó L2 y después L4, la
            // respuesta de L2 puede llegar última y dejaba el precio de L2 con la etiqueta L4 —
            // y ese es justo el número que le canta al cliente por teléfono.
            if (d?.ok && d.precio?.precio_vta != null && Number(d.cod_lista) === codLista) {
                const nuevo = Number(d.precio.precio_vta);
                setCart(c => c.map(i => i.uid === uid ? { ...i, precio: nuevo } : i));
            }
        } catch { /* si falla, queda el precio anterior y el backend recalcula al enviar */ }
    }
    /** Descuento del renglón, 0 a 100. Se edita como texto (mismo motivo que la cantidad). */
    const [descTexto, setDescTexto] = useState<Record<string, string>>({});
    function escribirDesc(uid: string, txt: string) {
        if (!/^\d{0,3}([.,]\d{0,2})?$/.test(txt)) return;
        setDescTexto(q => ({ ...q, [uid]: txt }));
        const n = Math.min(Math.max(Number(txt.replace(',', '.')) || 0, 0), 100);
        setCart(c => c.map(i => i.uid === uid ? { ...i, descuento: n } : i));
    }
    function cerrarDesc(uid: string) {
        setDescTexto(q => { const c = { ...q }; delete c[uid]; return c; });
    }
    const quitar = (uid: string) => setCart(c => c.filter(i => i.uid !== uid));
    const subtotalDe = (i: CartItem) => i.cantidad * i.precio * (1 - (i.descuento || 0) / 100);
    const total = useMemo(() => cart.reduce((a, i) => a + subtotalDe(i), 0), [cart]);

    // ── Control de listas ───────────────────────────────────────────────────
    // Se corre EN VIVO mientras arma el carrito: avisar recién al confirmar llega tarde,
    // ahí ya cargó todo el pedido y tendría que volver renglón por renglón.
    const [control, setControl] = useState<ControlListas | null>(null);
    /** Identidad del carrito actual. Cambia al agregar, borrar o reordenar renglones. */
    const firmaCarrito = useMemo(() => cart.map(i => i.uid).join('|'), [cart]);
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
                // La firma del carrito que ORIGINO este pedido: si el vendedor ya toco algo,
                // la respuesta llega vieja y los avisos no se muestran hasta la proxima vuelta.
                if (d?.ok) setControl({ ...d, firma: firmaCarrito });
            } catch { /* si falla el control el pedido sigue igual: avisa, no frena */ }
        }, 400);
        return () => { clearTimeout(timer); ctrl.abort(); };
    }, [cart]);
    // 🪤 Esto buscaba por cod_articulo con .find(), o sea que con el mismo artículo en dos
    // renglones los dos mostraban el aviso del PRIMERO. El backend manda un aviso por
    // renglón y en orden, con su `idx`: la posición es lo que los empareja.
    // Sólo se muestran los avisos del carrito que los generó: ver ControlListas.firma.
    const controlVigente = control?.firma === firmaCarrito ? control : null;
    const avisoDe = (idx: number) => { const a = controlVigente?.avisos?.[idx]; return a?.mensaje ? a : undefined; };
    const descDe = (idx: number) => controlVigente?.avisos?.[idx];
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
            // 🪤 El `uid` va SI O SI. Sin el, los renglones rearmados quedaban todos con
            // uid undefined y volvia el bug entero justo aca, que es el unico camino por el
            // que hoy entran renglones repetidos (la tabla no tiene indice unico).
            setCart((d.items ?? []).map((i: any): CartItem => ({
                uid: crypto.randomUUID(),
                cod_articulo: Number(i.cod_articulo),
                descripcion: String(i.descripcion ?? `Artículo ${i.cod_articulo}`),
                cantidad: Number(i.cantidad),
                precio: Number(i.precio_unit),
                cod_lista: Number(i.cod_lista_precios) || LISTA_DEFECTO,
                descuento: Number(i.descuento_porc) || 0,
            })));
            // La lista del pedido, no la del último cliente que se miró: el buscador cotiza
            // con esto y el vendedor puede agregarle un producto más al pedido abierto.
            setListaCliente(Number(d.pedido?.cod_lista_precios) || LISTA_DEFECTO);
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
                    setControl(c => ({ bultos: c?.bultos ?? 0, promo_general: c?.promo_general ?? false, avisos: d.avisos, firma: firmaCarrito }));
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
    // Detalle de solo lectura. Se pide una vez por pedido y queda cacheado mientras el
    // modal esté abierto: el vendedor abre y cierra el mismo pedido varias veces.
    const [abierto, setAbierto] = useState<string | null>(null);
    const [detalle, setDetalle] = useState<Record<string, { items: ItemGuardado[]; obs: string | null } | 'cargando' | 'error'>>({});

    async function verDetalle(p: Pedido) {
        if (abierto === p.id) { setAbierto(null); return; }
        setAbierto(p.id);
        if (detalle[p.id] && detalle[p.id] !== 'error') return;
        setDetalle(d => ({ ...d, [p.id]: 'cargando' }));
        try {
            const r = await fetch(`/api/pedidos/${p.id}`, { headers: authHeaders() });
            const j = await r.json().catch(() => null);
            if (!r.ok || !j?.ok) { setDetalle(d => ({ ...d, [p.id]: 'error' })); return; }
            setDetalle(d => ({ ...d, [p.id]: { items: j.items ?? [], obs: j.pedido?.observaciones ?? null } }));
        } catch {
            setDetalle(d => ({ ...d, [p.id]: 'error' }));
        }
    }
    const [pedLoading, setPedLoading] = useState(false);
    useEffect(() => {
        if (mode !== 'lista') return;
        setPedLoading(true);
        fetch('/api/pedidos', { headers: authHeaders() })
            .then(r => r.json()).then(d => setPedidos(d?.pedidos ?? [])).catch(() => {}).finally(() => setPedLoading(false));
    }, [mode, resultado]);

    // ── Semáforo de crédito ─────────────────────────────────────────────────
    // 🪤 Esto era un semáforo calculado sobre `disponible` (el cupo). Al sacar el cupo de la
    // pantalla el color quedaría dependiendo de un número que no se ve, así que ahora sólo
    // refleja el saldo, que es el que está a la vista: verde = al día o a favor, gris = debe.
    // No pinta de rojo a un deudor normal a propósito: en cuenta corriente casi todos deben
    // algo y un rojo permanente deja de mirarse.
    const credColor = credito ? (credito.saldo > 0 ? 'gray' : 'green') : 'gray';

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
                            // 🪤 Un pedido puede estar 'enviado' y a la vez tener algo que alguien
                            // tiene que ir a arreglar a mano: el caso real es que se creó el
                            // presupuesto nuevo pero NO se pudo anular el viejo, así que quedaron
                            // los DOS vivos y facturables. Eso se guardaba en `im_error` "para que
                            // se vea en la lista", pero la lista sólo miraba `estado` y lo pintaba
                            // VERDE, igual que un pedido sano. En verde no lo mira nadie nunca.
                            const e = p.im_error && p.estado === 'enviado'
                                ? { txt: 'Revisar ⚠️', cls: 'amber' }
                                : ESTADO_LABEL[p.estado] ?? { txt: p.estado, cls: 'gray' };
                            return (
                                <div key={p.id} className="ped-row">
                                    {/* Toda la fila abre el detalle: en el celular un chevron de 16px
                                        no se acierta, y mirar lo que cargaste no debería costar
                                        entrar al wizard de edición. */}
                                    <button className="ped-row-info" onClick={() => verDetalle(p)}
                                        aria-expanded={abierto === p.id}
                                        aria-label={`Ver el detalle del pedido de ${p.cliente_nombre ?? `Cliente ${p.cod_cliente}`}`}>
                                        <ChevronRight size={16} className={`ped-row-flecha${abierto === p.id ? ' abierta' : ''}`} />
                                        <div>
                                            <div className="ped-row-cli">{p.cliente_nombre ?? `Cliente ${p.cod_cliente}`}</div>
                                            <div className="ped-row-sub">{new Date(p.created_at).toLocaleDateString('es-AR')} · {money(p.total_estimado)}{p.im_numero ? ` · Nº ${p.im_numero}` : ''}</div>
                                        </div>
                                    </button>
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

                                    {abierto === p.id && (
                                        <div className="ped-detalle">
                                            {/* El chip de la fila dice CUÁL mirar; el motivo —que suele ser
                                                el error crudo de IM— vive acá adentro, a un toque. Sobre la
                                                fila manchaba la lista entera y descolocaba chip y botones. */}
                                            {p.im_error && (
                                                <div className="ped-det-problema">
                                                    <AlertTriangle size={14} />
                                                    <span>{p.im_error}</span>
                                                </div>
                                            )}
                                            {detalle[p.id] === 'cargando' && (
                                                <div className="ped-empty"><Loader2 className="spin" size={16} /> Cargando el detalle…</div>
                                            )}
                                            {detalle[p.id] === 'error' && (
                                                <div className="ped-detalle-error">
                                                    <AlertTriangle size={14} />
                                                    <span>No se pudo cargar el detalle.</span>
                                                    <button onClick={() => verDetalle(p)}>Reintentar</button>
                                                </div>
                                            )}
                                            {p.estado === 'facturado' && (
                                                <div className="ped-det-cerrado">
                                                    Ya lo facturó la oficina. No se puede editar ni anular desde acá:
                                                    si hay que cambiar algo, hablalo con administración.
                                                </div>
                                            )}
                                            {typeof detalle[p.id] === 'object' && (() => {
                                                const d = detalle[p.id] as { items: ItemGuardado[]; obs: string | null };
                                                if (!d.items.length) return <div className="ped-empty">Este pedido no tiene renglones.</div>;
                                                return (<>
                                                    {d.items.map((it, k) => (
                                                        <div key={k} className="ped-det-item">
                                                            <div className="ped-det-desc">
                                                                {it.descripcion ?? `Artículo ${it.cod_articulo}`}
                                                                {it.aviso_lista && <span className="ped-det-aviso">{it.aviso_lista}</span>}
                                                            </div>
                                                            <div className="ped-det-nums">
                                                                <span className="ped-det-cant">{Number(it.cantidad)} × {money(Number(it.precio_unit))}</span>
                                                                <span className="ped-det-tags">
                                                                    {NOMBRE_LISTA[Number(it.cod_lista_precios)] ?? '—'}
                                                                    {Number(it.descuento_porc) > 0 && <> · −{Number(it.descuento_porc)}%</>}
                                                                </span>
                                                            </div>
                                                            <div className="ped-det-sub">{money(Number(it.subtotal))}</div>
                                                        </div>
                                                    ))}
                                                    {d.obs && <div className="ped-det-obs">{d.obs}</div>}
                                                    <div className="ped-det-total">
                                                        <span>Total</span><b>{money(p.total_estimado)}</b>
                                                    </div>
                                                </>);
                                            })()}
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
                                {/* Nombre y localidad en UNA linea: la lista se recorre en el celular
                                    y dos renglones por cliente hacian que entraran 6 en pantalla. */}
                                <span className="ped-cli-txt">
                                    <span className="ped-cli-name">{c.name}</span>
                                    {c.localidad && <span className="ped-cli-loc">{c.localidad}</span>}
                                </span>
                            </button>
                        ))}
                        {cliError && (
                            <div className="ped-sin-resultados error">
                                <AlertTriangle size={15} />
                                <span>{cliError} La lista puede estar incompleta.</span>
                            </div>
                        )}
                        {clientesDeMas > 0 && (
                            <div className="ped-sin-resultados"><span>y {clientesDeMas} cliente{clientesDeMas === 1 ? '' : 's'} más — afiná la búsqueda.</span></div>
                        )}
                        {!clientesFiltrados.length && (
                            <div className="ped-empty">{cliLoading ? 'Cargando clientes…' : 'Sin resultados.'}</div>
                        )}
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
                                            ? <>Saldo {money(credito.saldo)}</>
                                            : 'Sin datos de saldo'}
                                    </div>
                                </div>
                            </div>

                            {/* Buscador de productos */}
                            <div className="ped-search">
                                <PackageSearch size={18} />
                                <input placeholder="Buscar producto…" value={catQuery} onChange={e => setCatQuery(e.target.value)} />
                                {catLoading && <Loader2 className="spin" size={16} />}
                            </div>
                            {catResults.map(a => {
                                // 🪤 Se podía agregar igual: el renglón quedaba en $0, el total del pie
                                // MENTÍA y recién frenaba al tocar Confirmar — con el pedido entero ya
                                // cargado y, peor, con ese total ya cantado por teléfono. El backend lo
                                // bloquea siempre, así que acá se falla temprano.
                                // Sólo cuando SABEMOS que la lista se pudo consultar (`hayPrecios`): si no
                                // se pudo, el artículo puede tener precio y se deja intentar — al agregarlo
                                // se recotiza contra IM.
                                const sinPrecio = hayPrecios && a.precio_venta == null;
                                return (
                                <button key={a.cod_articulo} className="ped-cat-opt" disabled={agregando != null || sinPrecio}
                                    title={sinPrecio ? 'No tiene precio en la lista de este cliente' : undefined}
                                    onClick={() => agregarArticulo(a)}>
                                    {agregando === a.cod_articulo ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
                                    <div className="ped-cat-desc">{a.descripcion}</div>
                                    <div className="ped-cat-precio">
                                        {a.precio_venta != null
                                            ? money(a.precio_venta)
                                            : <span className="ped-cat-sinprecio">{hayPrecios ? 'sin precio en esta lista' : 'precio no disponible'}</span>}
                                    </div>
                                </button>
                                );
                            })}
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

                            {cart.map((i, idx) => {
                                const av = avisoDe(idx);
                                const dsc = descDe(idx);
                                return (
                                <div key={i.uid} className="ped-cart-item">
                                    <div className="ped-cart-desc">{i.descripcion}<span className="ped-cart-precio">{money(i.precio)} c/u</span></div>
                                    <div className="ped-qty">
                                        <button aria-label="Restar uno" disabled={i.cantidad <= 1}
                                            onClick={() => setQty(i.uid, Math.max(1, Math.round(i.cantidad) - 1))}><Minus size={16} /></button>
                                        <input
                                            type="text" inputMode="decimal" aria-label={`Cantidad de ${i.descripcion}`}
                                            value={qtyTexto[i.uid] ?? String(i.cantidad)}
                                            onChange={e => escribirQty(i.uid, e.target.value)}
                                            onFocus={e => e.currentTarget.select()}
                                            onBlur={() => cerrarQty(i.uid)}
                                        />
                                        <button aria-label="Sumar uno"
                                            onClick={() => setQty(i.uid, Math.floor(i.cantidad) + 1)}><Plus size={16} /></button>
                                    </div>
                                    <select
                                        className={`ped-cart-lista${av ? ' alerta' : ''}`}
                                        value={i.cod_lista}
                                        onChange={e => setLista(i.uid, i.cod_articulo, Number(e.target.value))}
                                        title="Lista de precios de este renglón"
                                    >
                                        {LISTAS.map(l => <option key={l.cod} value={l.cod}>{l.label}</option>)}
                                    </select>
                                    <label className={`ped-desc${dsc?.mensaje_descuento ? ' alerta' : ''}`}
                                        title={dsc?.mensaje_descuento ?? (dsc && dsc.descuento_max > 0 ? `Hasta ${dsc.descuento_max}%` : 'Descuento de este renglón')}>
                                        <input
                                            type="text" inputMode="decimal" placeholder="0"
                                            aria-label={`Descuento en porcentaje de ${i.descripcion}`}
                                            value={descTexto[i.uid] ?? (i.descuento ? String(i.descuento) : '')}
                                            onChange={e => escribirDesc(i.uid, e.target.value)}
                                            onFocus={e => e.currentTarget.select()}
                                            onBlur={() => cerrarDesc(i.uid)}
                                        />
                                        <span>%</span>
                                    </label>
                                    <div className="ped-cart-sub">
                                        {money(subtotalDe(i))}
                                        {i.descuento > 0 && <span className="ped-cart-tachado">{money(i.cantidad * i.precio)}</span>}
                                    </div>
                                    <button className="ped-cart-del" onClick={() => quitar(i.uid)}><Trash2 size={14} /></button>
                                    {dsc?.mensaje_descuento && (
                                        <div className="ped-aviso margen">
                                            <AlertTriangle size={14} />
                                            <span>{dsc.mensaje_descuento}</span>
                                            {dsc.descuento_max > 0 && (
                                                <button onClick={() => escribirDesc(i.uid, String(dsc.descuento_max))}>
                                                    Poner {dsc.descuento_max}%
                                                </button>
                                            )}
                                            {dsc.descuento_max === 0 && (
                                                <button onClick={() => escribirDesc(i.uid, '')}>Sacar</button>
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
                                            <button onClick={() => setLista(i.uid, i.cod_articulo, av.lista_sugerida!)}>
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
