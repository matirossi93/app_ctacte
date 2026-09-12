import { useOperacionReparto } from './RepartoContext';
import { contextoReparto } from '../utils/contextoReparto';
import { useLecturaVigente } from '../utils/useLecturaVigente';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle, Truck, Plus, Loader2, X, Wand2, MapPin, Package,
    ChevronRight, RefreshCw, Trash2, Printer, CheckCircle2, Store, Lock, Unlock, FileMinus,
    MessageSquare, Search, ChevronDown, History,
} from 'lucide-react';
import { authHeaders } from '../utils/auth';
import { coincide } from '../utils/buscar';
import { useRecargarAlVolver } from '../utils/recargarAlVolver';
import { ImprimirHoja } from './ImprimirHoja';
import { AjustesHojaModal } from './AjustesHojaModal';
import './HojasRutaView.css';

/**
 * Armado de hojas de ruta: el ÚLTIMO paso del circuito. Reemplaza el panel de InfoManager.
 *
 * 📌 Acá ya no se factura (Mati, 08/09/2026: la hoja se arma *"con la factura y el remito
 * hecho"*). La emisión vive en la sección Facturación; lo que llega acá viaja con su remito, y
 * los comprobantes emitidos se muestran al lado de cada pedido.
 *
 * 🔑 LA DECISIÓN ES DE LA OFICINA, no del algoritmo (Mati, 07/09/2026: *"el criterio de cómo
 * asignar los camiones tiene que seguir siendo una decisión nuestra... por ahí quizás sí una
 * sugerencia"*). Por eso la sugerencia es un botón que PROPONE y se puede ignorar, y todo se
 * puede mover a mano después.
 */

/**
 * Un REMITO listo para salir. 🔄 Antes eran presupuestos: Mati (08/09/2026) pidió que la hoja se
 * arme con los comprobantes definitivos, y el remito es el que viaja con la mercadería.
 */
interface Pendiente {
    /** El id del remito en InfoManager: es lo que identifica la entrega. */
    im_comprobante_id: string;
    /** Número de REMITO. */
    im_numero: number | null;
    cod_cliente: number;
    cliente_nombre: string;
    cod_zona: number | null;
    zona: string;
    zona_origen: 'im' | 'nombre' | 'ninguno';
    /** 🪤 `null` cuando no se pudo verificar contra InfoManager: NO es cero. */
    total: number | null;
    importe_error?: string | null;
    bultos: number;
    kg: number;
    renglones_sin_peso: number; peso_completo?: boolean;
    fecha: string | null;
    /** De un día anterior y todavía sin salir: hay que mirarlo. */
    de_otro_dia: boolean;
    /** Lo que escribió el vendedor: puede cambiar cómo o cuándo se entrega. */
    observaciones: string | null;
    /** La factura del remito. InfoManager no guarda esa relación: se deduce (ver aparearFactura). */
    im_factura_id: string | null;
    im_factura_numero: number | null;
    im_factura_tipo: string | null;
    /** Cómo se supo cuál era: 'vinculo' | 'unica' | 'elegida' | 'ninguna'. */
    factura_origen: 'vinculo' | 'unica' | 'elegida' | 'ninguna';
    hoja_id: string | null;
}

interface HojaPedido {
    importe_error?: string | null;
    tipo_comprobante?: string; peso_completo?: boolean;
    im_comprobante_id: string;
    im_numero: number | null;
    cliente_nombre: string | null;
    /** Hace falta para atar una nota de crédito: sólo se vincula a un pedido del MISMO cliente. */
    cod_cliente: number;
    total: number | null;
    saldo_anterior: number | null;
    bultos: number | null;
    kg: number | null;
    /** Comprobantes emitidos en IM. Null = todavía no se facturó. */
    im_factura_numero: number | null;
    im_remito_numero: number | null;
    facturado_at: string | null;
}

interface Hoja {
    version: number;
    id: string; numero: number; turno: string | null; transporte: string | null;
    /**
     * 🔑 EL DÍA EN QUE SALE EL CAMIÓN. Mati (10/09/2026): *"las hojas de ruta tienen que poder
     * relacionarse a una fecha, porque muchas veces armamos hojas para días siguientes"*. Se
     * elige al crearla y se puede mover después, mientras la hoja no esté cerrada.
     */
    fecha: string;
    camion: string | null; camion_id: string | null; capacidad_kg: number | null;
    cod_zona: number | null; estado: string;
    /** Derivado en el server: todos los pedidos de la hoja tienen sus comprobantes emitidos. */
    facturada: boolean;
    chofer: string | null;
    /** El chofer al que se le va a liquidar esta hoja. */
    chofer_id: string | null;
    /** Cuándo se cerró. Una hoja cerrada ya volvió del reparto y entra en la liquidación. */
    cerrada_at: string | null;
    pedidos: HojaPedido[];
    totales: { pedidos: number; bultos: number; kg: number };
    carga: { completa?: boolean; porcentaje: number | null; excedido: boolean; sobra_kg: number | null };
}

interface Camion { id: string; nombre: string; capacidad_kg: number }
interface Chofer { id: string; nombre: string }

const money = (n: number) => '$' + Math.round(n).toLocaleString('es-AR');
const kilos = (n: number) => n.toLocaleString('es-AR', { maximumFractionDigits: 0 }) + ' kg';

/**
 * 🔑 El rango baja del header, igual que en Presupuestos, Fraccionado y Facturación. Mati
 * (09/09/2026): *"en la parte de hoja de ruta también el selector de fecha tiene que ser por
 * rango"*. Antes esta pantalla tenía su propio selector de UN día y su propio `?dias=N` para
 * estirar hacia atrás, así que el rango que elegía la oficina arriba no llegaba hasta acá.
 */
export function HojasRutaView({ desde, hasta }: { desde: string; hasta: string }) {
    /**
     * 🔑 CON QUÉ FECHA SE CREA UNA HOJA NUEVA. Mati (09/09/2026): *"las hojas de ruta tendrían que
     * tener fecha y poder elegirse, porque muchas veces armamos hojas de ruta para días
     * siguientes"*. Arranca en el final del rango —el día que se está mirando— y se puede mover
     * sin tocar el rango: se arma la hoja de mañana con los pedidos que ya están hoy.
     */
    const operacion = useOperacionReparto('Modificar entrega');
    const [fecha, setFecha] = useState(hasta);
    // Si se mueve el rango, la fecha de la hoja lo sigue, salvo que ya la hayan elegido a mano.
    const [fechaTocada, setFechaTocada] = useState(false);
    useEffect(() => { if (!fechaTocada) setFecha(hasta); }, [hasta, fechaTocada]);
    /** El buscador: sobre los pedidos que ya están en pantalla, por cliente o por comprobante. */
    const [busqueda, setBusqueda] = useState('');
    const [pendientes, setPendientes] = useState<Pendiente[]>([]);
    const versionesHoja = useRef(new Map<string, number>());
    const [hojas, setHojas] = useState<Hoja[]>([]);
    const [cargandoHojas, setCargandoHojas] = useState(true);
    const [errorHojas, setErrorHojas] = useState<string | null>(null);
    const [camiones, setCamiones] = useState<Camion[]>([]);
    /** Los choferes activos (Mati: NIÑO, VICTOR, DANIEL, MARIO, ELVIO, EDUARDO). */
    const [choferes, setChoferes] = useState<Chofer[]>([]);
    const [cargando, setCargando] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [sel, setSel] = useState<Set<string>>(new Set());
    const [trabajando, setTrabajando] = useState(false);
    const [aviso, setAviso] = useState<string | null>(null);
    /** Cuántos pedidos vigentes quedaron de días anteriores. null = todavía no se sabe. */
    const [arrastre, setArrastre] = useState<number | null>(null);
    /** Días cuyos renglones no se pudieron traer: los kilos de esos remitos van en 0. */
    const [diasSinPeso, setDiasSinPeso] = useState<string[]>([]);
    /**
     * Qué zonas están desplegadas. Arrancan CERRADAS: con 59 pedidos en 6 zonas había que
     * scrollear media pantalla para llegar a las hojas de ruta (Mati, 07/09/2026, desde el
     * celular). Cerradas, todo el día entra de una y se abre lo que se va a trabajar.
     */
    const [zonasAbiertas, setZonasAbiertas] = useState<Set<string>>(new Set());
    /** En el celular las dos columnas quedan una abajo de la otra: se muestra una por vez. */
    const [hojaEnlace] = useState(() => contextoReparto(location.search, hasta).hoja);
    const [panel, setPanel] = useState<'pedidos' | 'hojas'>(hojaEnlace ? 'hojas' : 'pedidos');
    /** Qué hoja se está imprimiendo. */
    const [imprimiendo, setImprimiendo] = useState<string | null>(null);
    /** Qué hoja tiene abierto el panel de diferencias de entrega (notas de crédito). */
    const [ajustando, setAjustando] = useState<Hoja | null>(null);
    /**
     * 🔑 Mati (10/09/2026): *"estaría bueno que las hojas de ruta puedan ser desplegables o
     * plegables porque se hace muy larga la lista"*. Se guarda quién está PLEGADA y no quién
     * abierta: así una hoja nueva aparece abierta, que es lo que uno quiere al crearla.
     */
    const [plegadas, setPlegadas] = useState<Set<string>>(new Set());
    /**
     * 🔑 *"tener una sección donde podamos ver el histórico de todas las hojas de ruta, si no
     * desaparecen con el filtro de fecha y es difícil encontrarlas"*.
     */
    const [historico, setHistorico] = useState(false);
    const [siguienteHoja, setSiguienteHoja] = useState<number | null>(null);

    /**
     * Las hojas solas. Sale de Supabase: es instantáneo.
     *
     * 🔑 Va SEPARADA de los pendientes a propósito. Antes cada acción —cambiar un camión,
     * sacar un pedido— llamaba a una recarga que incluía la consulta a InfoManager, y la
     * pantalla se quedaba ~7 segundos dura para guardar un dato que vive en nuestra base
     * (Mati, 07/09/2026: "revisar y pulir la velocidad al interactuar con la página").
     */
    const { iniciar: iniciarHojas } = useLecturaVigente(`${desde}|${hasta}|${historico}`);
    const { iniciar: iniciarPendientes } = useLecturaVigente(`${desde}|${hasta}`);
    const { iniciar: iniciarArrastre } = useLecturaVigente(`${desde}|${hasta}`);
    const { iniciar: iniciarChoferes } = useLecturaVigente('choferes');
    const [conflictosAsignacion, setConflictosAsignacion] = useState<any[]>([]);
    const cargarHojas = useCallback(async (antes?: number, forzar = true) => {
        const lectura = iniciarHojas(forzar); if (!lectura) return;
        setCargandoHojas(true); setErrorHojas(null);
        if (!antes) setHojas([]);
        try {
            const url = historico ? `/api/hojas-ruta?todas=1${antes ? `&antes=${antes}` : ''}` : `/api/hojas-ruta?desde=${desde}&hasta=${hasta}`;
            const h = await fetch(`${url}${forzar ? '&refrescar=1' : ''}`, { headers: authHeaders(), signal: lectura.signal });
            const d = await h.json().catch(() => null);
            if (!lectura.vigente()) return;
            if (!h.ok) throw new Error(d?.error ?? 'No se pudieron consultar las hojas');
            for (const hoja of d?.hojas ?? []) versionesHoja.current.set(hoja.id, hoja.version);
            setHojas(previas => antes ? [...previas, ...(d?.hojas ?? [])] : d?.hojas ?? []);
            setSiguienteHoja(d?.siguiente ?? null); lectura.confirmar();
        } catch (e: any) { if (lectura.vigente()) setErrorHojas(e?.message ?? 'No se pudieron consultar las hojas'); }
        finally { if (lectura.vigente()) setCargandoHojas(false); }
    }, [desde, hasta, historico, iniciarHojas]);
    useEffect(() => { void cargarHojas(undefined, false); }, [cargarHojas]);

    const enlaceUbicado = useRef(false);
    useEffect(() => {
        if (enlaceUbicado.current || !hojaEnlace || !hojas.some(h => h.id === hojaEnlace)) return;
        enlaceUbicado.current = true;
        const nodo = document.getElementById(`hoja-${hojaEnlace}`);
        nodo?.scrollIntoView({ block: 'center' }); nodo?.focus({ preventScroll: true });
    }, [hojaEnlace, hojas]);

    /**
     * Los pendientes: esto sí va a IM y tarda unos segundos.
     *
     * 🔑 Las hojas y los camiones se piden APARTE y se pintan apenas llegan, sin esperar a IM.
     * Antes la pantalla quedaba en blanco hasta que volvía todo junto, y lo primero que la
     * oficina quiere ver —las hojas que ya armó— sale de nuestra base en milisegundos.
     */
    const cargar = useCallback(async (refrescar = false) => {
        const lectura = iniciarPendientes(refrescar); if (!lectura) return;
        setPendientes([]); setConflictosAsignacion([]);
        avisarRecarga();
        setCargando(true); setError(null);
        // Lo rápido primero, sin await: la pantalla se dibuja mientras IM contesta.
        void fetch('/api/hojas-ruta/camiones', { headers: authHeaders(), signal: lectura.signal })
            .then(r => r.ok ? r.json() : null)
            .then(d => { if (lectura.vigente() && d?.camiones) setCamiones(d.camiones); })
            .catch(() => { /* sin la flota igual se puede armar la hoja */ });
        try {
            const p = await fetch(
                `/api/hojas-ruta/pendientes?desde=${desde}&hasta=${hasta}${refrescar ? '&refrescar=1' : ''}`,
                { headers: authHeaders(), signal: lectura.signal });
            const dp = await p.json().catch(() => null);
            if (!p.ok) throw new Error(dp?.error ?? 'No se pudieron traer los pedidos');
            if (!lectura.vigente()) return;
            setPendientes(dp.pendientes ?? []);
            // 🔑 Los días de los que no se pudieron traer los renglones: esos remitos salen con
            // 0 kg y la hoja parece entrar en el camión cuando puede no entrar. El server lo
            // calculaba y nadie lo leía (auditoría del 08/09/2026).
            setDiasSinPeso(Array.isArray(dp.dias_sin_items) ? dp.dias_sin_items : []);
            setConflictosAsignacion(dp.conflictos_asignacion ?? []);
            // 🪤 Y se suelta lo que dejó de poder elegirse: una fila ya seleccionada cuya factura
            // pasó a no verificarse no puede quedar marcada esperando entrar a una hoja.
            setSel(s => new Set([...s].filter(id =>
                (dp.pendientes ?? []).some((p: Pendiente) => p.im_comprobante_id === id && !p.importe_error))));
            lectura.confirmar();
        } catch (e: any) {
            if (lectura.vigente()) setError(e?.message ?? 'Error de conexión');
        } finally {
            if (lectura.vigente()) setCargando(false);
        }
    }, [desde, hasta, iniciarPendientes]);

    useEffect(() => { void cargar(); }, [cargar]);

    // Al volver de InfoManager: si allá se facturó o se anuló algo, acá tiene que verse.
    const avisarRecarga = useRecargarAlVolver(() => { if (!operacion.enCurso.current) { void cargar(true); void cargarHojas(); } });

    /**
     * Los choferes. Se piden UNA sola vez: son seis y no cambian de un día para el otro, así que
     * no tiene sentido volver a pedirlos cada vez que se cambia la fecha.
     */
    useEffect(() => {
        const lectura = iniciarChoferes(); if (!lectura) return;
        fetch('/api/choferes', { headers: authHeaders(), signal: lectura.signal })
            .then(r => r.ok ? r.json() : null)
            .then(d => { if (lectura.vigente() && d?.choferes) { setChoferes(d.choferes); lectura.confirmar(); } })
            .catch(() => { /* sin la lista se puede armar la hoja igual, sólo no se asigna chofer */ });
    }, [iniciarChoferes]);

    /**
     * Cuántos pedidos vigentes quedaron de días anteriores.
     *
     * Va en una llamada APARTE y después de dibujar el día: contarlos cuesta ~6 s contra IM y
     * no puede demorar la apertura de la pantalla. El 07/09/2026 había 417 — pedidos viejos
     * que nunca se facturaron y que, mostrados todos juntos, hacían la lista inusable.
     */
    useEffect(() => {
        const lectura = iniciarArrastre(); if (!lectura) return;
        setArrastre(null);
        fetch(`/api/hojas-ruta/arrastre?desde=${desde}&hasta=${hasta}`, { headers: authHeaders(), signal: lectura.signal })
            .then(r => r.ok ? r.json() : null)
            .then(d => { if (lectura.vigente() && d?.ok) { setArrastre(d.cantidad ?? 0); lectura.confirmar(); } })
            .catch(() => { /* el aviso es opcional: si no se puede contar, no se muestra */ });
    }, [desde, hasta, iniciarArrastre]);

    /** Agrupados por zona: es como se arma la hoja y como los mira la oficina. */
    const porZona = useMemo(() => {
        const g = new Map<string, { zona: string; cod_zona: number | null; filas: Pendiente[]; kg: number }>();
        for (const p of pendientes) {
            if (!coincide(busqueda, [p.cliente_nombre, p.im_numero, p.cod_cliente,
                                     (p as any).im_remito_numero, (p as any).im_factura_numero])) continue;
            const k = String(p.cod_zona ?? 'sin');
            if (!g.has(k)) g.set(k, { zona: p.zona, cod_zona: p.cod_zona, filas: [], kg: 0 });
            const x = g.get(k)!;
            x.filas.push(p); x.kg += p.kg;
        }
        return [...g.values()].sort((a, b) => {
            if (a.cod_zona == null) return 1;      // los sin zona al final: hay que mirarlos
            if (b.cod_zona == null) return -1;
            return b.kg - a.kg;                     // y las zonas más pesadas primero
        });
    }, [pendientes, busqueda]);

    // 🪤 Filtra también por elegible: defensa contra una selección vieja que sobrevivió a un
    // refresco en el que esa fila pasó a no tener importe acreditado.
    const seleccionados = useMemo(() => pendientes.filter(p => sel.has(p.im_comprobante_id) && !p.importe_error), [pendientes, sel]);
    const kgSel = seleccionados.reduce((s, p) => s + p.kg, 0);
    // 🔑 Separados a propósito: "36 para revisar" sobre 59 no dice nada y se deja de mirar.
    // Uno es plata que la empresa pierde, el otro es un cliente al que le cobran de más.
    /**
     * 🔄 Los chips del control de listas se fueron con el cambio a remitos, y está bien: acá ya
     * está todo facturado y la lista no se puede corregir. Ese control vive en Presupuestos,
     * que es donde todavía se puede hacer algo. Lo que sí importa acá es si falta la factura.
     */
    const sinFactura = pendientes.filter(p => p.im_factura_numero == null).length;
    const facturaDeducida = pendientes.filter(p => p.factura_origen === 'elegida').length;

    /**
     * 🔴 UNA FILA SIN IMPORTE ACREDITADO NO SE PUEDE ELEGIR.
     *
     * Su factura no se pudo verificar en InfoManager, así que no se sabe cuánto se le cobra al
     * cliente. Mandarla a una hoja la haría viajar con un importe que nadie confirmó — y el
     * backend la rechaza igual, pero recién después de intentar armar la hoja.
     */
    const elegible = (p: Pendiente) => !p.importe_error;

    function toggle(id: string) {
        const fila = pendientes.find(p => p.im_comprobante_id === id);
        if (fila && !elegible(fila)) return;
        setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    }
    function abrirCerrarZona(k: string) {
        setZonasAbiertas(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
    }
    function toggleZona(filas: Pendiente[]) {
        // 🪤 Sólo las elegibles: si no, la zona quedaría en indeterminado para siempre.
        const ids = filas.filter(elegible).map(f => f.im_comprobante_id);
        if (!ids.length) return;
        const todos = ids.every(i => sel.has(i));
        setSel(s => {
            const n = new Set(s);
            for (const i of ids) todos ? n.delete(i) : n.add(i);
            return n;
        });
    }

    /**
     * Crea una hoja. Con `conSeleccion`, le mete los pedidos elegidos en el mismo paso.
     *
     * 🪤 Antes el botón "Nueva hoja con estos" sólo creaba la hoja VACÍA, y como `cargar()`
     * limpia la selección, había que volver a marcar los pedidos uno por uno. El botón decía
     * una cosa y hacía otra.
     */
    async function nuevaHoja(codZona: number | null = null, conSeleccion = false) {
        if (!operacion.comenzar()) return;
        setTrabajando(true); setAviso(null);
        const paraMeter = conSeleccion ? seleccionados : [];
        try {
            const r = await fetch('/api/hojas-ruta', {
                method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ fecha, cod_zona: codZona }),
            });
            const d = await r.json().catch(() => null);
            if (d?.hoja?.id) versionesHoja.current.set(d.hoja.id, d.hoja.version);
            if (!r.ok) { setAviso(d?.error ?? 'No se pudo crear la hoja'); return; }
            if (paraMeter.length && d?.hoja?.id) {
                const ok = await mandarAHoja(d.hoja.id, paraMeter);
                if (!ok) { await cargarHojas(); return; }   // el error ya se mostró
                const ids = new Set(paraMeter.map(p => p.im_comprobante_id));
                setPendientes(ps => ps.filter(p => !ids.has(p.im_comprobante_id)));
                setSel(new Set());
            }
            await cargarHojas();
        } finally { setTrabajando(false); operacion.terminar(); }
    }

    /**
     * El POST de asignar, separado para que lo usen el botón de la hoja y el de "nueva hoja
     * con estos". Devuelve si salió bien.
     */
    async function mandarAHoja(hojaId: string, pedidos: Pendiente[], mover = false, origenesConfirmados?: Record<string, unknown>): Promise<boolean> {
        const r = await fetch(`/api/hojas-ruta/${hojaId}/pedidos`, {
            method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            // 🔑 `tipo: 'RE'` le dice al server que el comprobante que llega es el REMITO, así
            // que puede guardarlo como tal sin ir a buscarlo. Las hojas viejas se armaron con
            // presupuestos y por eso el server sigue aceptando las dos formas.
            body: JSON.stringify({ pedidos: pedidos.map(p => ({ ...p, tipo: 'RE' })), mover, rango: { desde, hasta }, version_esperada: versionesHoja.current.get(hojaId), origenes: origenesConfirmados ?? Object.fromEntries(pedidos.map(p => { const h = hojas.find(h => h.pedidos.some(x => x.im_comprobante_id === p.im_comprobante_id)); return [p.im_comprobante_id, h ? { hoja_id: h.id, version: h.version } : {}]; })) }),
        });
        const d = await r.json().catch(() => null);
        if (!r.ok) {
            // 🔑 El backend avisa cuándo se puede forzar. Sin esto, un pedido que ya está en
            // otra hoja obliga a ir a buscarlo y sacarlo a mano — y mover pedidos entre hojas
            // es la operación MÁS COMÚN cuando una zona se pasa de kilos.
            if (d?.mover_disponible && confirm(`${d.error}\n\n¿Los paso igual a esta hoja?`)) {
                return await mandarAHoja(hojaId, pedidos, true, d.origenes);
            }
            setAviso(d?.error ?? 'No se pudieron asignar');
            return false;
        }
        const partes: string[] = [];
        if (d?.sin_saldo > 0) partes.push(`de ${d.sin_saldo} no se pudo traer el saldo del cliente (van en blanco en la hoja impresa)`);
        if (d?.peso_recalculado === false) partes.push('hay pedidos sin peso verificado; la capacidad del camión está incompleta');
        if (partes.length) setAviso(`Se agregaron ${d.agregados}, pero ${partes.join('; ')}.`);
        return true;
    }

    async function asignar(hojaId: string) {
        if (!seleccionados.length) return;
        if (!operacion.comenzar()) return;
        setTrabajando(true); setAviso(null);
        try {
            const ids = new Set(seleccionados.map(p => p.im_comprobante_id));
            if (await mandarAHoja(hojaId, seleccionados)) {
                // Se sacan de la lista acá mismo en vez de volver a pedírselos a IM.
                setPendientes(ps => ps.filter(p => !ids.has(p.im_comprobante_id)));
                setSel(new Set());
            }
            await cargarHojas();
        } finally { setTrabajando(false); operacion.terminar(); }
    }

    /**
     * 🪤 Estas tres se comían el error: hacían `await fetch(...)` sin mirar la respuesta y
     * recargaban igual. Si el server rechazaba, la pantalla se refrescaba como si hubiera
     * funcionado y el usuario se quedaba pensando que el pedido salió de la hoja.
     */
    async function pedir(url: string, init: RequestInit, siFalla: string): Promise<boolean> {
        const r = await fetch(url, { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } });
        if (!r.ok) {
            const d = await r.json().catch(() => null);
            setAviso(d?.error ?? siFalla);
            return false;
        }
        return true;
    }

    async function quitar(comprobanteId: string) {
        if (!operacion.comenzar()) return;
        setTrabajando(true); setAviso(null);
        try {
            const origen = hojas.find(h => h.pedidos.some(p => p.im_comprobante_id === comprobanteId));
            if (await pedir(`/api/hojas-ruta/pedidos/${comprobanteId}?hoja_id=${origen?.id}&version_esperada=${origen?.version}`, { method: 'DELETE' }, 'No se pudo sacar el pedido de la hoja')) {
                await cargarHojas();
                // 🪤 El pedido vuelve a estar libre, pero sus datos (zona, avisos, peso) los
                // arma el backend con IM. Se recarga la lista en segundo plano: la hoja ya se
                // actualizó y la pantalla no espera.
                void cargar(true);
            }
        } finally { setTrabajando(false); operacion.terminar(); }
    }

    async function editarHoja(hojaId: string, cambios: Record<string, unknown>, siFalla: string) {
        if (!operacion.comenzar()) return;
        setTrabajando(true); setAviso(null);
        try {
            await pedir(`/api/hojas-ruta/${hojaId}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cambios, version_esperada: versionesHoja.current.get(hojaId) }),
            }, siFalla);
            await cargarHojas();   // el camión o el turno viven en nuestra base: no hace falta ir a IM
        } finally { setTrabajando(false); operacion.terminar(); }
    }

    /**
     * Cambia el día de reparto de una hoja.
     *
     * 🪤 Las hojas se listan por el RANGO de arriba. Si se la manda a un día que queda afuera, la
     * hoja desaparece de la pantalla y parece que se borró — hay que decirlo, no dejar que la
     * persona lo descubra.
     */
    async function moverHoja(h: Hoja, fechaNueva: string) {
        await editarHoja(h.id, { fecha: fechaNueva }, 'No se pudo cambiar la fecha de la hoja');
        if (fechaNueva < desde || fechaNueva > hasta) {
            const dm = `${fechaNueva.slice(8, 10)}/${fechaNueva.slice(5, 7)}`;
            setAviso(`La hoja ${h.numero} pasó al ${dm}, que está fuera del rango que estás viendo. Estirá el Desde o el Hasta de arriba para verla.`);
        }
    }

    /**
     * Cerrar la hoja: "esto ya se entregó".
     *
     * 🔴 Mati (08/09/2026): *"debería haber algún botón para guardar o cerrar la HR una vez que
     * ya terminó el circuito de ella, para que se vaya archivando"*. No es sólo archivar: a
     * partir de acá la hoja **entra en la liquidación del chofer**, y deja de poder tocarse.
     */
    async function cerrarHoja(h: Hoja) {
        const cerrando = h.estado !== 'cerrada';
        if (cerrando) {
            if (!h.chofer_id) { setAviso(`Asignale un chofer a la hoja ${h.numero} antes de cerrarla: es a quien se le liquida.`); return; }
            if (!confirm(`¿Cerrar la hoja ${h.numero}?\n\nEntra en la liquidación de ${h.chofer ?? 'el chofer'} y ya no se le pueden agregar ni sacar pedidos.`)) return;
        } else if (!confirm(`¿Reabrir la hoja ${h.numero}?\n\nSale de la liquidación del mes hasta que se vuelva a cerrar.`)) {
            return;
        }
        await editarHoja(h.id, { estado: cerrando ? 'cerrada' : 'abierta' },
            cerrando ? 'No se pudo cerrar la hoja' : 'No se pudo reabrir la hoja');
    }

    /**
     * Los pedidos que el cliente pasa a buscar: no salen en el camión.
     *
     * Mati (08/09/2026): *"hay algunos de esos pedidos que no van por hoja de ruta sino que los
     * clientes pasan a retirar (son pocos)"*. Van a su propia lista, que se acumula por mes.
     */
    async function marcarRetiro() {
        if (!seleccionados.length) return;
        if (!confirm(`¿Marcar ${seleccionados.length} pedido(s) como retiro en sucursal?\n\nNo salen en ninguna hoja de ruta: quedan en la lista de retiros del mes.`)) return;
        if (!operacion.comenzar()) return;
        setTrabajando(true); setAviso(null);
        try {
            const r = await fetch('/api/retiros', {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ rango: { desde, hasta },
                    pedidos: seleccionados.map(p => ({
                        im_comprobante_id: p.im_comprobante_id, im_numero: p.im_numero,
                        cod_cliente: p.cod_cliente, cliente_nombre: p.cliente_nombre,
                        fecha: p.fecha, total: p.total, bultos: p.bultos, kg: p.kg,
                    })),
                }),
            });
            const d = await r.json().catch(() => null);
            if (!r.ok) { setAviso(d?.error ?? 'No se pudieron marcar como retiro'); return; }
            // 🔑 Sin este aviso la acción no daba NINGUNA señal de haber hecho algo: los pedidos
            // salen de la lista recién cuando vuelve la consulta a IM, que tarda segundos.
            const sinFacturar = Number(d?.sin_facturar ?? 0);
            setAviso(`${d?.agregados ?? seleccionados.length} pedido(s) quedaron como retiro en sucursal.`
                + (sinFacturar ? ` ${sinFacturar} todavía sin facturar: el cliente no se los puede llevar sin remito.` : '')
                + ' Se ven en Retiros en sucursal.');
            setSel(new Set());
            // Salen de pendientes: la lista se rehace contra IM, sin bloquear la pantalla.
            void cargar(true);
        } finally { setTrabajando(false); operacion.terminar(); }
    }

    async function borrarHoja(hojaId: string, numero: number) {
        if (!confirm(`¿Borrar la hoja ${numero}? Los pedidos vuelven a la lista de pendientes.`)) return;
        if (!operacion.comenzar()) return;
        setTrabajando(true); setAviso(null);
        try {
            if (await pedir(`/api/hojas-ruta/${hojaId}?version_esperada=${versionesHoja.current.get(hojaId)}`, { method: 'DELETE' }, 'No se pudo borrar la hoja')) {
                await cargarHojas();
                void cargar(true);     // los pedidos vuelven a pendientes, sin bloquear la pantalla
            }
        } finally { setTrabajando(false); operacion.terminar(); }
    }

    return (
        <div className="hr-root">
            {!!conflictosAsignacion.length && <div className="hr-aviso" role="alert">Asignaciones a revisar: {conflictosAsignacion.map(p => `${p.cliente_nombre ?? "Cliente"} · ID ${p.im_comprobante_id}`).join("; ")}. Estos comprobantes no se ofrecen para otra hoja hasta conciliar sus vínculos.</div>}
            <div className="hr-top">
                {/* QUÉ pedidos se ven: lo elige el rango del header, arriba. */}
                <span className="hr-fecha-rango">
                    {desde === hasta
                        ? <>Pedidos del <b>{desde.slice(8, 10)}/{desde.slice(5, 7)}</b></>
                        : <>Pedidos del <b>{desde.slice(8, 10)}/{desde.slice(5, 7)}</b> al <b>{hasta.slice(8, 10)}/{hasta.slice(5, 7)}</b></>}
                </span>
                {/* 🔑 Con QUÉ FECHA se crea la hoja: se elige aparte del rango, porque la oficina
                    arma hoy la hoja de mañana con pedidos que ya están cargados (Mati, 09/09/2026). */}
                <label className="hr-fecha">
                    Hoja del
                    <input type="date" value={fecha}
                           onChange={e => { setFecha(e.target.value); setFechaTocada(true); }} />
                </label>
                <button className="hr-btn ghost" onClick={() => void cargar(true)} disabled={cargando}>
                    <RefreshCw size={15} className={cargando ? 'spin' : ''} /> Actualizar
                </button>
                <div className="hr-buscador">
                    <Search size={14} />
                    <input value={busqueda} onChange={e => setBusqueda(e.target.value)}
                           placeholder="Buscar cliente o comprobante…" />
                    {!!busqueda && <button onClick={() => setBusqueda('')} title="Limpiar"><X size={13} /></button>}
                </div>
                <div className="hr-resumen">
                    <span><b>{pendientes.length}</b> sin asignar</span>
                    <span><b>{kilos(pendientes.reduce((s, p) => s + p.kg, 0))}</b></span>
                    {sinFactura > 0 && (
                        <span className="hr-chip-aviso grave" title="No se encontró la factura de estos remitos. Salen igual en el camión, pero conviene mirarlos.">
                            <AlertTriangle size={13} /> {sinFactura} sin factura
                        </span>
                    )}
                    {facturaDeducida > 0 && (
                        <span className="hr-chip-aviso nota" title="El cliente tenía más de una factura por el mismo importe ese día: se tomó la más cercana en el tiempo. Verificá si el número importa.">
                            {facturaDeducida} con factura deducida
                        </span>
                    )}
                </div>
            </div>

            {!!arrastre && (
                <div className="hr-aviso">
                    <AlertTriangle size={15} />
                    <span>
                        Hay <b>{arrastre}</b> pedidos anteriores al {desde.slice(8, 10)}/{desde.slice(5, 7)} que
                        siguen sin salir. Estirá el <b>Desde</b> de arriba para verlos.
                    </span>
                </div>
            )}
            {aviso && <div className="hr-aviso"><AlertTriangle size={15} /><span>{aviso}</span><button onClick={() => setAviso(null)}><X size={14} /></button></div>}
            {/* 🔴 Los kilos mienten POR ABAJO: una hoja puede parecer que entra en el camión y no
                entrar. Es lo único que no se puede deducir mirando la pantalla. */}
            {diasSinPeso.length > 0 && (
                <div className="hr-aviso">
                    <AlertTriangle size={15} />
                    <span>
                        No se pudieron traer los renglones de {diasSinPeso.length} día(s)
                        ({diasSinPeso.join(', ')}): esos remitos van con <b>0 kg</b>, así que el peso
                        del camión está calculado <b>de menos</b>. Probá con menos días o volvé a actualizar.
                    </span>
                </div>
            )}

            {error && <div className="hr-aviso error"><AlertTriangle size={15} /><span>{error}</span></div>}

            {/* En el celular las dos columnas quedan una abajo de la otra y hay que scrollear
                toda la lista de pedidos para llegar a las hojas. Se muestra una por vez. */}
            <div className="hr-panel-tabs">
                <button className={panel === 'pedidos' ? 'on' : ''} onClick={() => setPanel('pedidos')}>
                    Pedidos {pendientes.length > 0 && <b>{pendientes.length}</b>}
                </button>
                <button className={panel === 'hojas' ? 'on' : ''} onClick={() => setPanel('hojas')}>
                    Hojas de ruta {hojas.length > 0 && <b>{hojas.length}</b>}
                </button>
            </div>

            <div className="hr-cols" data-panel={panel}>
                {/* ─── Pendientes, agrupados por zona ─────────────────────────── */}
                <section className="hr-col hr-col-pedidos">
                    <h2 className="hr-col-title"><MapPin size={16} /> Pedidos sin asignar</h2>

                    {cargando && <div className="hr-cargando"><Loader2 className="spin" size={20} /> Trayendo los pedidos…</div>}
                    {!cargando && !error && !pendientes.length && (
                        <div className="hr-vacio"><Package size={26} /><span>No quedan pedidos sin asignar.</span></div>
                    )}

                    {/* 🪤 Buscando no hay nada que plegar: si la zona del cliente que buscás queda
                        cerrada, el buscador "no encuentra nada" aunque lo haya encontrado. Mati
                        (10/09/2026) pidió un buscador acá — ya estaba, lo que faltaba era esto. */}
                    {!!busqueda.trim() && !porZona.length && !cargando && !error && (
                        <div className="hr-vacio"><Search size={22} />
                            <span>Ningún pedido sin asignar coincide con “{busqueda}”.</span>
                        </div>
                    )}

                    {porZona.map(g => {
                        const k = String(g.cod_zona ?? 'sin');
                        const abierta = zonasAbiertas.has(k) || !!busqueda.trim();
                        const elegibles = g.filas.filter(elegible);
                        const elegidos = elegibles.filter(f => sel.has(f.im_comprobante_id)).length;
                        const conAviso = g.filas.filter(f => f.im_factura_numero == null).length;
                        const sinVerificar = g.filas.length - elegibles.length;
                        return (
                        <div className={`hr-zona${abierta ? ' abierta' : ''}`} key={k}>
                            <div className="hr-zona-head">
                                {/* El checkbox elige la zona entera sin tener que desplegarla. */}
                                <input
                                    type="checkbox" title="Elegir toda la zona"
                                    checked={elegidos === elegibles.length && !!elegibles.length}
                                    disabled={!elegibles.length}
                                    ref={el => { if (el) el.indeterminate = elegidos > 0 && elegidos < elegibles.length; }}
                                    onChange={() => toggleZona(g.filas)}
                                />
                                <button className="hr-zona-abrir" onClick={() => abrirCerrarZona(k)}>
                                    <ChevronRight size={15} className="hr-chevron" />
                                    <span className={`hr-zona-nombre${g.cod_zona == null ? ' sin' : ''}`}>{g.zona}</span>
                                    <span className="hr-zona-meta">
                                        {g.filas.length} ped · {kilos(g.kg)}
                                        {conAviso > 0 && <span className="hr-zona-alerta" title="Pedidos por debajo de la lista que corresponde"> · {conAviso} ⚠</span>}
                                        {sinVerificar > 0 && <span className="hr-zona-pendiente" title="No se pudo verificar su importe en InfoManager: no se pueden elegir"> · {sinVerificar} sin verificar</span>}
                                        {elegidos > 0 && <span className="hr-zona-elegidos"> · {elegidos} elegidos</span>}
                                    </span>
                                </button>
                            </div>
                            {abierta && g.filas.map(p => (
                                <label className={`hr-ped${sel.has(p.im_comprobante_id) ? ' sel' : ''}${p.importe_error ? ' sin-verificar' : ''}`} key={p.im_comprobante_id}>
                                    <input type="checkbox" checked={sel.has(p.im_comprobante_id)} disabled={!elegible(p)}
                                           title={p.importe_error ? 'No se puede elegir: falta verificar su importe' : undefined}
                                           onChange={() => toggle(p.im_comprobante_id)} />
                                    <div className="hr-ped-info">
                                        <div className="hr-ped-cli">
                                            <span>{p.cliente_nombre}</span>
                                            {p.de_otro_dia && (
                                                <span className="hr-badge tenue" title="Es de otro día y sigue sin salir">
                                                    {String(p.fecha ?? '').slice(8, 10)}/{String(p.fecha ?? '').slice(5, 7)}
                                                </span>
                                            )}
                                            {/* La factura del remito. `elegida` = el cliente tenía más de una
                                                por el mismo importe ese día y se tomó la más cercana en el
                                                tiempo: se avisa, porque el número puede no ser el correcto. */}
                                            {p.im_factura_numero != null ? (
                                                <span className={`hr-badge ${p.factura_origen === 'elegida' ? 'aviso' : 'facturada'}`}
                                                      title={p.factura_origen === 'elegida'
                                                          ? 'Había más de una factura del cliente por el mismo importe: se tomó la más cercana en el tiempo. Verificala si el número importa.'
                                                          : 'La factura de este remito'}>
                                                    <CheckCircle2 size={11} /> {p.im_factura_tipo ?? 'FA'} {p.im_factura_numero}
                                                    {p.factura_origen === 'elegida' && ' ?'}
                                                </span>
                                            ) : (
                                                <span className="hr-badge grave" title="No se encontró la factura de este remito. Sale igual, pero conviene mirarlo.">
                                                    <AlertTriangle size={11} /> sin factura
                                                </span>
                                            )}
                                            {p.zona_origen === 'nombre' && <span className="hr-badge tenue" title="La zona se dedujo del nombre del cliente, no está cargada en InfoManager">zona estimada</span>}
                                        </div>
                                        <div className="hr-ped-meta">
                                            RE {p.im_numero ?? '—'} · {p.importe_error
                                                ? <b className="hr-sin-importe">importe sin verificar</b>
                                                : money(Number(p.total))} · {p.bultos} bultos
                                            {(!p.peso_completo || p.renglones_sin_peso > 0) && (
                                                <span className="hr-sinpeso" title="Estos renglones no tienen peso cargado en el catálogo: los kilos de este pedido son un mínimo, puede pesar más">
                                                    · {p.renglones_sin_peso} sin peso
                                                </span>
                                            )}
                                        </div>
                                        {/* 🔑 Por qué no se puede elegir. Se lee, no se adivina de un tooltip. */}
                                        {p.importe_error && <div className="hr-sinpeso" role="status">{p.importe_error}</div>}
                                        {/* 🔑 Lo que escribió el vendedor. Acá decide en qué camión va y en
                                            qué orden, y ahí puede decir "entregar el jueves temprano" o
                                            "avisar antes de ir" (Mati, 08/09/2026). */}
                                        {p.observaciones && (
                                            <div className="hr-obs-im"><MessageSquare size={12} /> <span>{p.observaciones}</span></div>
                                        )}
                                    </div>
                                    <div className="hr-ped-kg">{kilos(p.kg)}</div>
                                </label>
                            ))}
                        </div>
                        );
                    })}
                </section>

                {/* ─── Hojas del día ──────────────────────────────────────────── */}
                <section className="hr-col hr-col-hojas">
                    <h2 className="hr-col-title">
                        <Truck size={16} /> Hojas de ruta
                        <button className="hr-btn chico" onClick={() => void nuevaHoja()} disabled={trabajando}>
                            <Plus size={14} /> Nueva
                        </button>
                    </h2>

                    {/* 🔑 Ver todas, sin el filtro de fecha: es la única forma de repasar que estén
                        bien las de días anteriores sin ir adivinando el rango. */}
                    <div className="hr-hojas-barra">
                        <button className={'hr-btn ghost chico' + (historico ? ' activo' : '')}
                                onClick={() => { setHistorico(v => !v); setPlegadas(new Set()); }}>
                            <History size={14} /> {historico ? 'Ver sólo las del rango' : 'Ver todas las hojas'}
                        </button>
                        {!!hojas.length && (
                            <button className="hr-btn ghost chico"
                                    onClick={() => setPlegadas(p => p.size ? new Set() : new Set(hojas.map(h => h.id)))}>
                                {plegadas.size ? 'Desplegar todas' : 'Plegar todas'}
                            </button>
                        )}
                        {historico && <span className="hr-hojas-cuenta">{hojas.length} hojas</span>}
                        {siguienteHoja != null && <button className="hr-btn ghost chico" onClick={() => void cargarHojas(siguienteHoja)}>Cargar más hojas</button>}
                    </div>

                    {errorHojas && <div className="hr-aviso error" role="alert">{errorHojas}</div>}
                    {cargandoHojas && <div className="hr-cargando" role="status"><Loader2 className="spin" size={20} /> Trayendo las hojas…</div>}
                    {!hojas.length && !cargandoHojas && !errorHojas && (
                        <div className="hr-vacio"><Truck size={26} />
                            <span>{historico ? 'Todavía no hay ninguna hoja.' : 'Todavía no hay hojas para este rango.'}</span>
                        </div>
                    )}

                    {hojas.map(h => {
                      // 🔒 Cerrada = ya volvió del reparto y se liquidó: no se le toca nada.
                      const cerrada = h.estado === 'cerrada';
                      const plegada = plegadas.has(h.id);
                      const sinPesoVerificado = h.pedidos.filter(p => p.peso_completo !== true);
                      return (
                        <div id={`hoja-${h.id}`} tabIndex={-1} className={`hr-hoja${h.carga.excedido ? ' excedida' : ''}${cerrada ? ' cerrada' : ''}${plegada ? ' plegada' : ''}`} key={h.id}>
                            <div className="hr-hoja-head">
                                {/* 🔑 Plegar: con muchas hojas la lista se hace interminable. El
                                    número y el resumen quedan siempre a la vista. */}
                                <button className="hr-plegar" title={plegada ? 'Desplegar' : 'Plegar'}
                                        onClick={() => setPlegadas(p => {
                                            const n = new Set(p);
                                            if (n.has(h.id)) n.delete(h.id); else n.add(h.id);
                                            return n;
                                        })}>
                                    {plegada ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                                </button>
                                <span className="hr-hoja-num">Hoja {h.numero}</span>
                                <button className="hr-btn ghost chico" aria-label={`Copiar enlace a hoja ${h.numero}`} onClick={async () => {
                                    const u = new URL(location.href); u.searchParams.set('etapa', 'hojas'); u.searchParams.set('hoja', h.id); u.searchParams.set('desde', h.fecha); u.searchParams.set('hasta', h.fecha);
                                    try { await navigator.clipboard.writeText(u.toString()); setAviso(`Enlace a hoja ${h.numero} copiado.`); } catch { setAviso(`Enlace: ${u.toString()}`); }
                                }}>Enlace</button>
                                {plegada && (
                                    <span className="hr-plegada-resumen">
                                        {String(h.fecha ?? '').slice(0, 10)} · {h.pedidos.length} pedido{h.pedidos.length === 1 ? '' : 's'}
                                        {h.camion ? ` · ${h.camion}` : ''}
                                    </span>
                                )}
                                {/* 🔑 El que empuja los controles a la derecha. Antes ese trabajo lo
                                    hacía un `margin-left:auto` en el select del camión, y como el
                                    resto de la fila no tenía anchos fijos, cada hoja repartía el
                                    espacio distinto: el número se partía en dos líneas, el select
                                    quedaba de otro ancho y los íconos a otra distancia del borde
                                    (Mati, 10/09/2026: *"acá hay un problema de diseño"*). */}
                                <span className="hr-hoja-sep" />
                                {/* La fecha de reparto, editable: se arma la hoja hoy para mañana
                                    y a veces hay que correrla un día. Cerrada no se toca: ya se
                                    liquidó. */}
                                <input
                                    className="hr-hoja-fecha"
                                    type="date"
                                    value={String(h.fecha ?? '').slice(0, 10)}
                                    title="Día en que sale esta hoja"
                                    onChange={e => e.target.value && void moverHoja(h, e.target.value)}
                                    disabled={trabajando || cerrada}
                                />
                                {cerrada && (
                                    <span className="hr-badge cerrada" title="Cerrada: entró en la liquidación del chofer">
                                        <Lock size={11} /> cerrada
                                    </span>
                                )}
                                {h.facturada && !cerrada && (
                                    <span className="hr-badge facturada" title="Todos los pedidos de esta hoja tienen su factura y su remito">
                                        <CheckCircle2 size={11} /> facturada
                                    </span>
                                )}
                                <select value={h.camion_id ?? ''} onChange={e => void editarHoja(h.id, { camion_id: e.target.value || null }, 'No se pudo cambiar el camión')} disabled={trabajando || cerrada}>
                                    <option value="">Sin camión</option>
                                    {camiones.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                                </select>
                                <button className="hr-icono" title={h.pedidos.some(p => p.importe_error) ? 'Verificá los importes pendientes antes de imprimir' : 'Imprimir la hoja y el listado de fraccionado'} onClick={() => setImprimiendo(h.id)} disabled={!h.pedidos.length || h.pedidos.some(p => p.importe_error)}>
                                    <Printer size={14} />
                                </button>
                                <button className="hr-icono" title="Borrar la hoja" onClick={() => void borrarHoja(h.id, h.numero)} disabled={trabajando || cerrada}>
                                    <Trash2 size={14} />
                                </button>
                            </div>

                            {!plegada && <>
                            {/* Turno y chofer van impresos en la cabecera de la hoja de ruta
                                ("Turno: Mañana · Transporte: Niño"), así que se cargan acá.
                                🔑 Chofer y transportista son el MISMO dato (Mati, 08/09/2026), y
                                de él sale el pago: por eso es una lista y no un texto libre. */}
                            <div className="hr-hoja-datos">
                                <select value={h.turno ?? ''} onChange={e => void editarHoja(h.id, { turno: e.target.value || null }, 'No se pudo cambiar el turno')} disabled={trabajando || cerrada}>
                                    <option value="">Turno…</option>
                                    <option value="Mañana">Mañana</option>
                                    <option value="Tarde">Tarde</option>
                                </select>
                                <select
                                    className={h.chofer_id ? '' : 'sin-chofer'}
                                    value={h.chofer_id ?? ''}
                                    onChange={e => void editarHoja(h.id, { chofer_id: e.target.value || null }, 'No se pudo asignar el chofer')}
                                    disabled={trabajando || cerrada}
                                >
                                    <option value="">Sin chofer…</option>
                                    {choferes.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                                    {/* 🪤 /api/choferes devuelve sólo los activos. Si la hoja apunta a uno dado
                                        de baja, sin esta opción el select se dibuja VACÍO y la tarjeta no dice
                                        a quién se le está liquidando — mientras la liquidación sí le imputa
                                        el importe. Se muestra con el nombre que trae la hoja. */}
                                    {h.chofer_id && !choferes.some(c => c.id === h.chofer_id) && (
                                        <option value={h.chofer_id}>{h.chofer ?? 'Chofer dado de baja'} (inactivo)</option>
                                    )}
                                </select>
                            </div>
                            {/* Hojas viejas cargadas con transporte a mano: el dato no se pierde. */}
                            {!h.chofer_id && h.transporte && (
                                <div className="hr-transporte-viejo">Transporte cargado a mano: <b>{h.transporte}</b></div>
                            )}

                            {/* La barra es el dato que evita que se arme una hoja que no entra en el camión. */}
                            <div className="hr-carga">
                                <div className="hr-barra">
                                    <div className="hr-barra-fill" style={{ width: `${Math.min(h.carga.porcentaje ?? 0, 100)}%` }} />
                                </div>
                                <span className="hr-carga-txt">
                                    {kilos(h.totales.kg)}
                                    {h.capacidad_kg ? ` de ${kilos(Number(h.capacidad_kg))} · ${h.carga.porcentaje}%` : ' · sin camión asignado'}
                                </span>
                            </div>
                            {h.carga.completa === false && (
                                <details className="hr-peso-pendiente">
                                    <summary>Peso estimado{sinPesoVerificado.length > 0 && ` · ${sinPesoVerificado.length} pedido${sinPesoVerificado.length === 1 ? '' : 's'} sin verificar`}</summary>
                                    <p>Falta verificar el peso de estos pedidos para confirmar los kilos y compararlos con la capacidad del camión.</p>
                                    <ul>{sinPesoVerificado.map(p => (
                                        <li key={p.im_comprobante_id}>{p.cliente_nombre ?? 'Cliente'}{p.im_numero != null && ` · Comprobante ${p.im_numero}`}</li>
                                    ))}</ul>
                                </details>
                            )}
                            {h.carga.excedido && (
                                <div className="hr-excede"><AlertTriangle size={13} /> Se pasa {kilos(Math.abs(h.carga.sobra_kg ?? 0))} de la capacidad</div>
                            )}

                            {h.pedidos.map(p => {
                              const emitido = p.im_factura_numero != null || !!p.facturado_at;
                              return (
                                <div className="hr-hoja-ped" key={p.im_comprobante_id}>
                                    <div>
                                        <div className="hr-ped-cli">
                                            <span>{p.cliente_nombre ?? `Cliente`}</span>
                                            {/* Lo que se emitió queda a la vista: es el registro de qué salió de
                                                este presupuesto, y en IM ese vínculo no existe. */}
                                            {emitido && (
                                                <span className="hr-badge facturada" title="Comprobantes emitidos en InfoManager">
                                                    <CheckCircle2 size={11} /> FA {p.im_factura_numero ?? '—'}
                                                    {p.im_remito_numero != null && ` · RE ${p.im_remito_numero}`}
                                                </span>
                                            )}
                                        </div>
                                        <div className="hr-ped-meta">
                                            {p.tipo_comprobante ?? 'Comprobante'} {p.im_numero ?? '—'} · {kilos(Number(p.kg ?? 0))}
                                            {p.saldo_anterior != null
                                                ? <> · saldo <b>{money(Number(p.saldo_anterior))}</b></>
                                                : <span className="hr-sinpeso" title="No se pudo traer el saldo: va en blanco en la hoja impresa"> · sin saldo</span>}
                                        </div>
                                        {p.importe_error && <div className="hr-sinpeso" role="status">Importe por verificar: {p.importe_error}</div>}
                                    </div>
                                    <button
                                        className="hr-icono"
                                        title={cerrada ? 'La hoja está cerrada: reabrila para sacar pedidos' : 'Sacar de la hoja'}
                                        onClick={() => void quitar(p.im_comprobante_id)}
                                        disabled={trabajando || cerrada}
                                    >
                                        <X size={14} />
                                    </button>
                                </div>
                              );
                            })}


                            {!!seleccionados.length && !cerrada && (
                                <button className="hr-btn asignar" onClick={() => void asignar(h.id)} disabled={trabajando}>
                                    <ChevronRight size={15} /> Mandar {seleccionados.length} acá ({kilos(kgSel)})
                                </button>
                            )}

                            {/* El cierre del circuito: lo que volvió del reparto y el archivado.
                                Sólo tiene sentido con la hoja armada. */}
                            {!!h.pedidos.length && (
                                <div className="hr-hoja-pie">
                                    <button className="hr-btn ghost chico" onClick={() => setAjustando(h)} disabled={trabajando}>
                                        <FileMinus size={14} /> Diferencias
                                    </button>
                                    <button className="hr-btn chico" onClick={() => void cerrarHoja(h)} disabled={trabajando || (!cerrada && h.pedidos.some(p => p.importe_error))}>
                                        {cerrada ? <><Unlock size={14} /> Reabrir</> : <><Lock size={14} /> Cerrar hoja</>}
                                    </button>
                                </div>
                            )}
                            </>}
                        </div>
                      );
                    })}
                </section>
            </div>

            {imprimiendo && <ImprimirHoja hojaId={imprimiendo} onClose={() => setImprimiendo(null)} />}

            {/* Lo que volvió del reparto: las notas de crédito y el número final de la hoja. */}
            {ajustando && (() => {
                const h = ajustando;
                return (
                    <AjustesHojaModal
                        hojaId={h.id}
                        numero={h.numero}
                        pedidos={h.pedidos}
                        onClose={() => setAjustando(null)}
                        onCambio={() => void cargarHojas()}
                    />
                );
            })()}

            {/* Barra de selección: siempre a la vista mientras haya algo elegido. */}
            {!!seleccionados.length && (
                <div className="hr-barra-sel">
                    <span><b>{seleccionados.length}</b> pedidos · {kilos(kgSel)}</span>
                    <button className="hr-btn ghost" onClick={() => setSel(new Set())}>Deseleccionar</button>
                    {/* Los que el cliente pasa a buscar: no salen en ninguna hoja. */}
                    <button className="hr-btn ghost" onClick={() => void marcarRetiro()} disabled={trabajando}>
                        <Store size={15} /> Retira el cliente
                    </button>
                    <button className="hr-btn" onClick={() => void nuevaHoja(seleccionados[0]?.cod_zona ?? null, true)} disabled={trabajando}>
                        <Wand2 size={15} /> Nueva hoja con estos
                    </button>
                </div>
            )}
        </div>
    );
}
