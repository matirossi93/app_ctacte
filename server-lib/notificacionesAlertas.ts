/**
 * Alertas para la campana de notificaciones — calcula por vendedor las
 * alertas de "cliente que dejó de comprar" y "producto en abandono" usando
 * el mismo análisis que el expand del cliente, pero para TODOS los
 * clientes asignados al vendedor en una sola pasada.
 *
 * Cache RAM por vendedor (10min). La primera llamada hace 1 pasada por
 * ~300k ventas y ~600k items del snapshot cache (no toca IM); las
 * siguientes responden desde RAM en ms.
 */

import { peekMonthlyVentas, peekMonthlyItems } from './snapshotCache.js';
import { fetchArticulosCatalogo, fetchClientesIMCached } from './infomanager.js';
import {
  ultimosMeses,
  armarFacturas,
  calcularAlertaCliente,
  detectarProductosAbandono,
} from './historialCompras.js';

export interface AlertaCampana {
  tipo: 'cliente_abandono' | 'producto_abandono';
  cod_cliente: number;
  razon_social: string;
  cod_vendedor: number;
  dias_sin_comprar: number;
  nivel?: 'amarillo' | 'rojo';
  media_dias?: number;
  cod_articulo?: number;
  detalle?: string;
  intervalo_medio_dias?: number;
}

interface CacheEntry { alertas: AlertaCampana[]; expiresAt: number }
const TTL_MS = 10 * 60 * 1000;
const cache = new Map<number, CacheEntry>();

export function invalidateAlertasVendedor(codVendedor?: number): void {
  if (codVendedor != null) cache.delete(codVendedor); else cache.clear();
}

export async function calcularAlertasVendedor(codVendedor: number): Promise<AlertaCampana[]> {
  const cached = cache.get(codVendedor);
  if (cached && cached.expiresAt > Date.now()) return cached.alertas;
  const t0 = Date.now();
  const result = await computar(codVendedor);
  cache.set(codVendedor, { alertas: result, expiresAt: Date.now() + TTL_MS });
  console.log(`[alertas vendedor=${codVendedor}] ${result.length} alertas en ${Date.now() - t0}ms`);
  return result;
}

async function computar(codVendedor: number): Promise<AlertaCampana[]> {
  const { tipoComprobante, isAnulada } = await import('../src/utils/ventas.js');
  const { COD_EMPRESA_CASA_CENTRAL, COD_CLIENTES_INTERNOS } = await import('./comisionesShared.js');

  const [clientes, articulos] = await Promise.all([
    fetchClientesIMCached(),
    fetchArticulosCatalogo(),
  ]);

  const misClientes = clientes.filter((c: any) => Number(c.cod_vendedor) === codVendedor);
  if (misClientes.length === 0) return [];

  const codClienteSet = new Set(misClientes.map((c: any) => Number(c.cod_cliente)));
  const razonSocialMap = new Map<number, string>(
    misClientes.map((c: any) => [Number(c.cod_cliente), String(c.razon_social ?? `#${c.cod_cliente}`)])
  );

  // Snapshot cache (6 meses). Si algún mes falta, seguimos con lo que haya:
  // el análisis necesita ≥3 FAs y media de intervalos; con datos parciales
  // detectamos menos casos pero no fallamos.
  const meses = ultimosMeses(6);
  const ventasAll: any[] = [];
  const itemsAll: any[] = [];
  for (const { year, month } of meses) {
    const v = peekMonthlyVentas(year, month);
    const it = peekMonthlyItems(year, month);
    if (v) ventasAll.push(...v);
    if (it) itemsAll.push(...it);
  }
  if (ventasAll.length === 0) return []; // cache aún no calentado

  // Una sola pasada por ventasAll: agrupar cabeceras válidas por cod_cliente.
  const cabsPorCliente = new Map<number, Map<number, any>>();
  for (const v of ventasAll) {
    const id = Number(v.id);
    if (!Number.isFinite(id)) continue;
    const codCli = Number(v.cod_cliente);
    if (!codClienteSet.has(codCli)) continue;
    if (COD_CLIENTES_INTERNOS.has(codCli)) continue;
    const codEmp = Number(v.cod_empresa);
    if (Number.isFinite(codEmp) && codEmp !== COD_EMPRESA_CASA_CENTRAL) continue;
    if (isAnulada(v)) continue;
    const tipo = tipoComprobante(v);
    let sign: 1 | -1;
    if (tipo.startsWith('ND')) continue;
    else if (tipo.startsWith('NC')) sign = -1;
    else if (tipo.startsWith('F')) sign = 1;
    else continue;
    let cabsCliente = cabsPorCliente.get(codCli);
    if (!cabsCliente) { cabsCliente = new Map(); cabsPorCliente.set(codCli, cabsCliente); }
    cabsCliente.set(id, {
      id,
      fecha: String(v.fecha ?? v.fa_fecha ?? '').slice(0, 10),
      tipo,
      tipo_factura: v.tipo_factura ?? tipo,
      punto_de_venta: v.punto_de_venta,
      numero: v.numero,
      fa_total: Number(v.fa_total ?? v.total ?? 0),
      sign,
    });
  }

  if (cabsPorCliente.size === 0) return [];

  // Indexar items por id_comprobante para acceso O(1) al filtrar por cliente.
  // No necesitamos un Map por cliente — basta consultar contra el set local
  // de IDs del cliente cuando analicemos cada uno.
  const itemsPorComprobante = new Map<number, any[]>();
  for (const it of itemsAll) {
    const idC = Number(it.id_comprobante);
    if (!Number.isFinite(idC)) continue;
    let arr = itemsPorComprobante.get(idC);
    if (!arr) { arr = []; itemsPorComprobante.set(idC, arr); }
    arr.push(it);
  }

  const ahora = new Date();
  const result: AlertaCampana[] = [];
  for (const [codCliente, cabsValidas] of cabsPorCliente) {
    const itemsCliente: any[] = [];
    for (const id of cabsValidas.keys()) {
      const arr = itemsPorComprobante.get(id);
      if (arr) itemsCliente.push(...arr);
    }
    const facturas = armarFacturas(cabsValidas, itemsCliente, articulos);

    const alertaCli = calcularAlertaCliente(facturas, ahora);
    if (alertaCli && alertaCli.nivel) {
      result.push({
        tipo: 'cliente_abandono',
        cod_cliente: codCliente,
        razon_social: razonSocialMap.get(codCliente) ?? `#${codCliente}`,
        cod_vendedor: codVendedor,
        dias_sin_comprar: alertaCli.dias_sin_comprar,
        media_dias: alertaCli.media_dias_entre_compras,
        nivel: alertaCli.nivel,
      });
    }

    // Top 3 productos en abandono por cliente — no inundamos la campana.
    const productosAb = detectarProductosAbandono(facturas, ahora).slice(0, 3);
    for (const p of productosAb) {
      result.push({
        tipo: 'producto_abandono',
        cod_cliente: codCliente,
        razon_social: razonSocialMap.get(codCliente) ?? `#${codCliente}`,
        cod_vendedor: codVendedor,
        cod_articulo: p.cod_articulo,
        detalle: p.detalle,
        dias_sin_comprar: p.dias_sin_comprar,
        intervalo_medio_dias: p.intervalo_medio_dias,
      });
    }
  }

  // Severidad descendente: clientes rojo > amarillo > productos por ratio.
  result.sort((a, b) => {
    const ra = a.tipo === 'cliente_abandono' ? (a.nivel === 'rojo' ? 0 : 1) : 2;
    const rb = b.tipo === 'cliente_abandono' ? (b.nivel === 'rojo' ? 0 : 1) : 2;
    if (ra !== rb) return ra - rb;
    return b.dias_sin_comprar - a.dias_sin_comprar;
  });

  return result;
}
