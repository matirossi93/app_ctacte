# Historial de compras por cliente — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cuando el vendedor expande la tarjeta de un cliente en la tab Objetivos, ver dos rankings (top por $ + más habituales) y la lista de últimas facturas del trimestre.

**Architecture:** Endpoint backend nuevo que reusa el cache RAM mensual de ventas+items ya existente, agregando por cliente. Componente UI nuevo se monta dentro del bloque expandido de `ClienteObjetivoCard` con lazy fetch.

**Tech Stack:** TypeScript, Express, React, vitest (unit), Playwright (E2E).

**Spec:** [docs/superpowers/specs/2026-05-25-historial-compras-cliente-design.md](../specs/2026-05-25-historial-compras-cliente-design.md).

**Branch:** `feat/cliente-historial-compras` desde `main`.

---

## File Structure

**Backend:**
- Create `server-lib/historialCompras.ts` — handler del endpoint + funciones puras de agregación.
- Create `server-lib/historialCompras.test.ts` — tests unitarios de las funciones puras.
- Modify `server.ts` — registrar la ruta `GET /api/clientes/:cod/historial-compras`.

**Frontend:**
- Modify `src/components/VendorShell.tsx` — extender `ClienteObjetivoCard`, agregar sub-componentes `TopProductosCliente` y `ComprasRecientesCliente`, agregar interfaces de tipo.
- Modify `src/components/VendorShell.css` — estilos para las nuevas secciones.

**Tests E2E:**
- Create `tests/historial-compras.spec.ts` — flujo del vendedor abriendo una card y validando el render.

---

## Task 0: Crear branch

**Files:** —

- [ ] **Step 1: Crear branch desde main**

```bash
git checkout main
git pull
git checkout -b feat/cliente-historial-compras
```

- [ ] **Step 2: Verificar branch limpio**

Run: `git status`
Expected: `On branch feat/cliente-historial-compras, nothing to commit, working tree clean`

---

## Task 1: Función pura — detectar líneas técnicas

**Files:**
- Create: `server-lib/historialCompras.ts`
- Create: `server-lib/historialCompras.test.ts`

- [ ] **Step 1: Crear el archivo de tests con un test que falla**

`server-lib/historialCompras.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { esLineaTecnica } from './historialCompras.js';

describe('esLineaTecnica', () => {
  it('matchea flete (case insensitive)', () => {
    expect(esLineaTecnica('FLETE EMPRESA TRANSPORTE')).toBe(true);
    expect(esLineaTecnica('Flete CABA')).toBe(true);
    expect(esLineaTecnica('flete')).toBe(true);
  });

  it('matchea descuento, bonif, ajuste, redondeo, percepcion', () => {
    expect(esLineaTecnica('DESCUENTO COMERCIAL')).toBe(true);
    expect(esLineaTecnica('BONIF VOLUMEN')).toBe(true);
    expect(esLineaTecnica('AJUSTE PRECIO')).toBe(true);
    expect(esLineaTecnica('REDONDEO')).toBe(true);
    expect(esLineaTecnica('PERCEPCION IIBB')).toBe(true);
  });

  it('NO matchea productos reales', () => {
    expect(esLineaTecnica('MIX ENERGETICO 25KG')).toBe(false);
    expect(esLineaTecnica('TIERNITOS 25KG')).toBe(false);
    expect(esLineaTecnica('GRAN CAMPEON CARNE 21KG')).toBe(false);
  });

  it('strings vacíos / null tratados como NO técnicos (no descartar línea por dato faltante)', () => {
    expect(esLineaTecnica('')).toBe(false);
    expect(esLineaTecnica(null as any)).toBe(false);
    expect(esLineaTecnica(undefined as any)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test y verificar que falla**

Run: `npx vitest run server-lib/historialCompras.test.ts`
Expected: FAIL "Cannot find module './historialCompras.js'"

- [ ] **Step 3: Implementar mínimo en `server-lib/historialCompras.ts`**

```ts
/**
 * Historial de compras por cliente — endpoint + helpers de agregación.
 *
 * Reusa el cache RAM mensual de snapshotCache.ts (mismas ventas+items que
 * usa /api/comisiones). Filtra por cod_cliente y agrega top productos +
 * lista de últimas facturas.
 *
 * Spec: docs/superpowers/specs/2026-05-25-historial-compras-cliente-design.md
 */

const PATRONES_LINEA_TECNICA = ['flete', 'descuento', 'bonif', 'ajuste', 'redondeo', 'percepcion'];

/** True si el detalle del artículo corresponde a un concepto técnico (no producto real). */
export function esLineaTecnica(detalle: string | null | undefined): boolean {
  if (!detalle) return false;
  const lower = String(detalle).toLowerCase();
  return PATRONES_LINEA_TECNICA.some(p => lower.includes(p));
}
```

- [ ] **Step 4: Run test y verificar que pasa**

Run: `npx vitest run server-lib/historialCompras.test.ts`
Expected: PASS 4/4 tests

- [ ] **Step 5: Commit**

```bash
git add server-lib/historialCompras.ts server-lib/historialCompras.test.ts
git commit -m "feat(historial-compras): helper esLineaTecnica con tests"
```

---

## Task 2: Función pura — agregar items por artículo

**Files:**
- Modify: `server-lib/historialCompras.ts`
- Modify: `server-lib/historialCompras.test.ts`

- [ ] **Step 1: Sumar tests para `agregarPorArticulo`**

Agregar al final de `server-lib/historialCompras.test.ts`:

```ts
import { agregarPorArticulo } from './historialCompras.js';

describe('agregarPorArticulo', () => {
  it('suma cantidades e importes con signo por cabecera', () => {
    const items = [
      { id_comprobante: 1, cod_articulo: 100, cantidad: 2, importe: 1000 },
      { id_comprobante: 1, cod_articulo: 101, cantidad: 1, importe: 500 },
      { id_comprobante: 2, cod_articulo: 100, cantidad: 3, importe: 1500 },
      // NC: signo -1
      { id_comprobante: 3, cod_articulo: 100, cantidad: 1, importe: 500 },
    ];
    const signos = new Map<number, { sign: 1 | -1; fecha: string }>([
      [1, { sign: 1, fecha: '2026-05-10' }],
      [2, { sign: 1, fecha: '2026-05-20' }],
      [3, { sign: -1, fecha: '2026-05-22' }],
    ]);
    const articulosMap = new Map<number, { descripcion: string }>([
      [100, { descripcion: 'Mix Energético 25kg' }],
      [101, { descripcion: 'Tiernitos 25kg' }],
    ]);
    const agg = agregarPorArticulo(items, signos, articulosMap);

    const a100 = agg.get(100)!;
    // FA1: 2 + FA2: 3 - NC3: 1 = 4 unidades
    expect(a100.cantidad_total).toBe(4);
    // FA1: 1000 + FA2: 1500 - NC3: 500 = 2000
    expect(a100.importe_total).toBe(2000);
    // Aparece en 3 facturas distintas (id 1, 2 y 3)
    expect(a100.num_facturas).toBe(3);
    expect(a100.ultima_compra).toBe('2026-05-22');
    expect(a100.detalle).toBe('Mix Energético 25kg');

    const a101 = agg.get(101)!;
    expect(a101.cantidad_total).toBe(1);
    expect(a101.importe_total).toBe(500);
    expect(a101.num_facturas).toBe(1);
  });

  it('excluye items sin cabecera válida (no en signos map)', () => {
    const items = [{ id_comprobante: 999, cod_articulo: 100, cantidad: 5, importe: 5000 }];
    const signos = new Map<number, { sign: 1 | -1; fecha: string }>();
    const articulosMap = new Map<number, { descripcion: string }>([[100, { descripcion: 'X' }]]);
    const agg = agregarPorArticulo(items, signos, articulosMap);
    expect(agg.size).toBe(0);
  });

  it('usa detalle del item si articulosMap no tiene el código', () => {
    const items = [{ id_comprobante: 1, cod_articulo: 555, cantidad: 1, importe: 100, detalle: 'PRODUCTO DESDE ITEM' } as any];
    const signos = new Map([[1, { sign: 1 as const, fecha: '2026-05-01' }]]);
    const articulosMap = new Map<number, { descripcion: string }>();
    const agg = agregarPorArticulo(items, signos, articulosMap);
    expect(agg.get(555)?.detalle).toBe('PRODUCTO DESDE ITEM');
  });
});
```

- [ ] **Step 2: Run y verificar que falla**

Run: `npx vitest run server-lib/historialCompras.test.ts`
Expected: FAIL "agregarPorArticulo is not a function"

- [ ] **Step 3: Implementar en `server-lib/historialCompras.ts`**

Agregar después de `esLineaTecnica`:

```ts
export interface AgregadoArticulo {
  cod_articulo: number;
  detalle: string;
  cantidad_total: number;
  importe_total: number;
  num_facturas: number;
  ultima_compra: string; // 'YYYY-MM-DD'
}

interface CabeceraSigno {
  sign: 1 | -1;
  fecha: string;
}

/**
 * Agrupa los items por `cod_articulo`, aplicando el signo de cada cabecera
 * (FA suma, NC resta). Devuelve un Map para que el caller pueda armar varios
 * rankings sin re-iterar los items.
 *
 * Items cuya cabecera no está en `signos` se descartan (cabecera inválida
 * = no Casa Central, anulada, no FA/NC, no este cliente).
 */
export function agregarPorArticulo(
  items: Array<{ id_comprobante: number; cod_articulo: number | string; cantidad: number | string; importe?: number | string; precio?: number | string; detalle?: string }>,
  signos: Map<number, CabeceraSigno>,
  articulosMap: Map<number, { descripcion: string }>
): Map<number, AgregadoArticulo> {
  const acc = new Map<number, AgregadoArticulo>();
  const facturasPorArt = new Map<number, Set<number>>();

  for (const it of items) {
    const cab = signos.get(Number(it.id_comprobante));
    if (!cab) continue;

    const codArt = Number(it.cod_articulo);
    if (!Number.isFinite(codArt)) continue;

    const cantidad = Number(it.cantidad ?? 0);
    const importe = Number(it.importe ?? 0);
    if (!Number.isFinite(cantidad) || !Number.isFinite(importe)) continue;

    const sign = cab.sign;
    const detalleArt = String(
      (it as any).detalle ?? articulosMap.get(codArt)?.descripcion ?? `#${codArt}`
    ).trim();

    let a = acc.get(codArt);
    if (!a) {
      a = {
        cod_articulo: codArt,
        detalle: detalleArt,
        cantidad_total: 0,
        importe_total: 0,
        num_facturas: 0,
        ultima_compra: cab.fecha,
      };
      acc.set(codArt, a);
      facturasPorArt.set(codArt, new Set());
    }

    a.cantidad_total += cantidad * sign;
    a.importe_total += importe * sign;
    if (cab.fecha > a.ultima_compra) a.ultima_compra = cab.fecha;

    facturasPorArt.get(codArt)!.add(Number(it.id_comprobante));
  }

  for (const [cod, set] of facturasPorArt) {
    const a = acc.get(cod);
    if (a) a.num_facturas = set.size;
  }

  return acc;
}
```

- [ ] **Step 4: Run y verificar que pasa**

Run: `npx vitest run server-lib/historialCompras.test.ts`
Expected: PASS todos los tests (los de esLineaTecnica + los 3 nuevos).

- [ ] **Step 5: Commit**

```bash
git add server-lib/historialCompras.ts server-lib/historialCompras.test.ts
git commit -m "feat(historial-compras): agregarPorArticulo con tests"
```

---

## Task 3: Funciones puras — top por importe y top por frecuencia

**Files:**
- Modify: `server-lib/historialCompras.ts`
- Modify: `server-lib/historialCompras.test.ts`

- [ ] **Step 1: Sumar tests**

```ts
import { topPorImporte, topPorFrecuencia } from './historialCompras.js';

describe('topPorImporte', () => {
  it('ordena desc por importe_total y slice 5', () => {
    const agg = new Map([
      [1, { cod_articulo: 1, detalle: 'A', cantidad_total: 0, importe_total: 100, num_facturas: 1, ultima_compra: '2026-05-01' }],
      [2, { cod_articulo: 2, detalle: 'B', cantidad_total: 0, importe_total: 500, num_facturas: 1, ultima_compra: '2026-05-01' }],
      [3, { cod_articulo: 3, detalle: 'C', cantidad_total: 0, importe_total: 300, num_facturas: 1, ultima_compra: '2026-05-01' }],
      [4, { cod_articulo: 4, detalle: 'D', cantidad_total: 0, importe_total: 50, num_facturas: 1, ultima_compra: '2026-05-01' }],
      [5, { cod_articulo: 5, detalle: 'E', cantidad_total: 0, importe_total: 700, num_facturas: 1, ultima_compra: '2026-05-01' }],
      [6, { cod_articulo: 6, detalle: 'F', cantidad_total: 0, importe_total: 200, num_facturas: 1, ultima_compra: '2026-05-01' }],
    ]);
    const top = topPorImporte(agg, 5);
    expect(top.map(t => t.cod_articulo)).toEqual([5, 2, 3, 6, 1]);
    expect(top).toHaveLength(5);
  });

  it('excluye negativos (NC > FA del mismo artículo => importe neto negativo, no debe aparecer en top "más comprado")', () => {
    const agg = new Map([
      [1, { cod_articulo: 1, detalle: 'A', cantidad_total: 1, importe_total: -100, num_facturas: 1, ultima_compra: '2026-05-01' }],
      [2, { cod_articulo: 2, detalle: 'B', cantidad_total: 1, importe_total: 200, num_facturas: 1, ultima_compra: '2026-05-01' }],
    ]);
    expect(topPorImporte(agg, 5).map(t => t.cod_articulo)).toEqual([2]);
  });
});

describe('topPorFrecuencia', () => {
  it('ordena desc por num_facturas, desempata por importe_total', () => {
    const agg = new Map([
      [1, { cod_articulo: 1, detalle: 'A', cantidad_total: 0, importe_total: 100, num_facturas: 3, ultima_compra: '2026-05-01' }],
      [2, { cod_articulo: 2, detalle: 'B', cantidad_total: 0, importe_total: 200, num_facturas: 3, ultima_compra: '2026-05-01' }],
      [3, { cod_articulo: 3, detalle: 'C', cantidad_total: 0, importe_total: 50, num_facturas: 5, ultima_compra: '2026-05-01' }],
    ]);
    expect(topPorFrecuencia(agg, 5).map(t => t.cod_articulo)).toEqual([3, 2, 1]);
  });

  it('excluye artículos con frecuencia 0 (no debería pasar pero defensivo)', () => {
    const agg = new Map([
      [1, { cod_articulo: 1, detalle: 'A', cantidad_total: 0, importe_total: 100, num_facturas: 0, ultima_compra: '2026-05-01' }],
    ]);
    expect(topPorFrecuencia(agg, 5)).toEqual([]);
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run server-lib/historialCompras.test.ts`
Expected: FAIL "topPorImporte is not a function"

- [ ] **Step 3: Implementar**

Agregar al final de `server-lib/historialCompras.ts`:

```ts
export function topPorImporte(agg: Map<number, AgregadoArticulo>, n: number): AgregadoArticulo[] {
  return Array.from(agg.values())
    .filter(a => a.importe_total > 0)
    .sort((a, b) => b.importe_total - a.importe_total)
    .slice(0, n);
}

export function topPorFrecuencia(agg: Map<number, AgregadoArticulo>, n: number): AgregadoArticulo[] {
  return Array.from(agg.values())
    .filter(a => a.num_facturas > 0)
    .sort((a, b) => {
      if (b.num_facturas !== a.num_facturas) return b.num_facturas - a.num_facturas;
      return b.importe_total - a.importe_total;
    })
    .slice(0, n);
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `npx vitest run server-lib/historialCompras.test.ts`
Expected: PASS todos los tests.

- [ ] **Step 5: Commit**

```bash
git add server-lib/historialCompras.ts server-lib/historialCompras.test.ts
git commit -m "feat(historial-compras): topPorImporte y topPorFrecuencia"
```

---

## Task 4: Función pura — armar facturas ordenadas con items

**Files:**
- Modify: `server-lib/historialCompras.ts`
- Modify: `server-lib/historialCompras.test.ts`

- [ ] **Step 1: Tests**

```ts
import { armarFacturas } from './historialCompras.js';

describe('armarFacturas', () => {
  it('agrupa items por id_comprobante, ordena facturas desc por fecha, aplica signo en items', () => {
    const cabsValidas = new Map<number, any>([
      [1, { id: 1, fecha: '2026-05-10', tipo: 'FA', tipo_factura: 'A', punto_de_venta: 1, numero: 100, fa_total: 1500, sign: 1 }],
      [2, { id: 2, fecha: '2026-05-22', tipo: 'NC', tipo_factura: 'A', punto_de_venta: 1, numero: 78, fa_total: 500, sign: -1 }],
      [3, { id: 3, fecha: '2026-05-20', tipo: 'FA', tipo_factura: 'A', punto_de_venta: 1, numero: 101, fa_total: 1500, sign: 1 }],
    ]);
    const items = [
      { id_comprobante: 1, cod_articulo: 100, cantidad: 2, importe: 1000, detalle: 'Mix' },
      { id_comprobante: 1, cod_articulo: 200, cantidad: 1, importe: 500, detalle: 'Tiernitos' },
      { id_comprobante: 2, cod_articulo: 100, cantidad: 1, importe: 500, detalle: 'Mix' },
      { id_comprobante: 3, cod_articulo: 100, cantidad: 3, importe: 1500, detalle: 'Mix' },
    ];
    const articulosMap = new Map<number, { descripcion: string }>();

    const facturas = armarFacturas(cabsValidas, items, articulosMap);

    expect(facturas).toHaveLength(3);
    // Orden desc por fecha
    expect(facturas.map(f => f.id_comprobante)).toEqual([2, 3, 1]);
    // NC con signo aplicado en items
    const nc = facturas.find(f => f.tipo === 'NC')!;
    expect(nc.items[0].importe).toBe(-500);
    expect(nc.items[0].cantidad).toBe(-1);
    expect(nc.total_neto).toBe(-500);
    // FA con signo positivo
    const fa = facturas.find(f => f.numero === 100)!;
    expect(fa.items).toHaveLength(2);
    expect(fa.total_neto).toBe(1500);
  });

  it('descarta items técnicos (flete, descuento, etc)', () => {
    const cabsValidas = new Map<number, any>([
      [1, { id: 1, fecha: '2026-05-10', tipo: 'FA', tipo_factura: 'A', punto_de_venta: 1, numero: 100, fa_total: 1500, sign: 1 }],
    ]);
    const items = [
      { id_comprobante: 1, cod_articulo: 100, cantidad: 2, importe: 1000, detalle: 'Mix Energético' },
      { id_comprobante: 1, cod_articulo: 999, cantidad: 1, importe: 500, detalle: 'FLETE CABA' },
    ];
    const facturas = armarFacturas(cabsValidas, items, new Map());
    expect(facturas[0].items).toHaveLength(1);
    expect(facturas[0].items[0].detalle).toBe('Mix Energético');
  });

  it('factura sin items (caso raro) aparece con items vacíos', () => {
    const cabsValidas = new Map<number, any>([
      [1, { id: 1, fecha: '2026-05-10', tipo: 'FA', tipo_factura: 'A', punto_de_venta: 1, numero: 100, fa_total: 1500, sign: 1 }],
    ]);
    const facturas = armarFacturas(cabsValidas, [], new Map());
    expect(facturas).toHaveLength(1);
    expect(facturas[0].items).toEqual([]);
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run server-lib/historialCompras.test.ts`
Expected: FAIL "armarFacturas is not a function"

- [ ] **Step 3: Implementar**

Agregar al final de `historialCompras.ts`:

```ts
export interface FacturaHistorial {
  id_comprobante: number;
  fecha: string;
  tipo: 'FA' | 'NC';
  tipo_factura: string;
  punto_venta: number;
  numero: number;
  total_neto: number;
  items: Array<{ cod_articulo: number; detalle: string; cantidad: number; importe: number }>;
}

interface CabeceraValida {
  id: number;
  fecha: string;
  tipo: string;
  tipo_factura?: string;
  punto_de_venta?: number;
  numero?: number;
  fa_total?: number;
  sign: 1 | -1;
}

export function armarFacturas(
  cabsValidas: Map<number, CabeceraValida>,
  items: Array<{ id_comprobante: number; cod_articulo: number | string; cantidad: number | string; importe?: number | string; detalle?: string }>,
  articulosMap: Map<number, { descripcion: string }>
): FacturaHistorial[] {
  const itemsPorComp = new Map<number, FacturaHistorial['items']>();

  for (const it of items) {
    const cab = cabsValidas.get(Number(it.id_comprobante));
    if (!cab) continue;

    const detalle = String(
      (it as any).detalle ?? articulosMap.get(Number(it.cod_articulo))?.descripcion ?? `#${it.cod_articulo}`
    ).trim();
    if (esLineaTecnica(detalle)) continue;

    const arr = itemsPorComp.get(Number(it.id_comprobante)) ?? [];
    arr.push({
      cod_articulo: Number(it.cod_articulo),
      detalle,
      cantidad: Number(it.cantidad ?? 0) * cab.sign,
      importe: Number(it.importe ?? 0) * cab.sign,
    });
    itemsPorComp.set(Number(it.id_comprobante), arr);
  }

  const facturas: FacturaHistorial[] = [];
  for (const [id, cab] of cabsValidas) {
    const clase: 'FA' | 'NC' = cab.sign === -1 ? 'NC' : 'FA';
    facturas.push({
      id_comprobante: id,
      fecha: cab.fecha,
      tipo: clase,
      tipo_factura: String(cab.tipo_factura ?? cab.tipo ?? ''),
      punto_venta: Number(cab.punto_de_venta ?? 0),
      numero: Number(cab.numero ?? 0),
      total_neto: Number(cab.fa_total ?? 0) * cab.sign,
      items: itemsPorComp.get(id) ?? [],
    });
  }

  facturas.sort((a, b) => {
    if (a.fecha === b.fecha) return b.id_comprobante - a.id_comprobante;
    return a.fecha < b.fecha ? 1 : -1;
  });

  return facturas;
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `npx vitest run server-lib/historialCompras.test.ts`
Expected: PASS todos los tests.

- [ ] **Step 5: Commit**

```bash
git add server-lib/historialCompras.ts server-lib/historialCompras.test.ts
git commit -m "feat(historial-compras): armarFacturas con orden y filtro técnico"
```

---

## Task 5: Handler del endpoint

**Files:**
- Modify: `server-lib/historialCompras.ts`

- [ ] **Step 1: Implementar `historialComprasCliente`**

Agregar al final de `server-lib/historialCompras.ts`:

```ts
import type { Request, Response } from 'express';
import type { JwtPayload } from './auth.js';
import { tipoComprobante, isAnulada } from '../src/utils/ventas.js';
import { getMonthlyVentasRaw, getMonthlyItemsRaw } from './snapshotCache.js';
import { fetchArticulosCatalogo, fetchClientesIMCached } from './infomanager.js';
import { COD_EMPRESA_CASA_CENTRAL, COD_CLIENTES_INTERNOS } from './comisionesShared.js';

const MESES_DEFAULT = 3;

function ultimosMeses(n: number, ref?: Date): Array<{ year: number; month: number }> {
  const d = ref ?? new Date();
  const list: Array<{ year: number; month: number }> = [];
  for (let i = 0; i < n; i++) {
    const dd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    list.push({ year: dd.getUTCFullYear(), month: dd.getUTCMonth() + 1 });
  }
  return list;
}

function clasificarCabecera(cab: any): 'FA' | 'NC' | null {
  if (isAnulada(cab)) return null;
  const tipo = tipoComprobante(cab);
  if (tipo.startsWith('ND')) return null;
  if (tipo.startsWith('NC')) return 'NC';
  if (tipo.startsWith('F')) return 'FA';
  return null;
}

/**
 * GET /api/clientes/:cod/historial-compras?meses=3
 *
 * Auth:
 *   - admin / gerente: cualquier cliente.
 *   - vendedor: solo si el cliente pertenece al vendedor (matching de
 *     cod_vendedor del cliente en IM contra user.cod_vendedor del JWT).
 *   - cualquier otro rol (incluido repartidor): 403.
 */
export async function historialComprasCliente(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (!user || (user.rol !== 'admin' && user.rol !== 'gerente' && user.rol !== 'vendedor')) {
      res.status(403).json({ error: 'No autorizado para ver el historial de compras' });
      return;
    }

    const codCliente = Number(req.params.cod);
    if (!Number.isFinite(codCliente) || codCliente <= 0) {
      res.status(400).json({ error: 'cod_cliente inválido' });
      return;
    }

    const meses = Number(req.query.meses ?? MESES_DEFAULT);
    if (meses !== MESES_DEFAULT) {
      res.status(400).json({ error: `meses debe ser ${MESES_DEFAULT}` });
      return;
    }

    if (user.rol === 'vendedor') {
      const clientesIM = await fetchClientesIMCached();
      const cli = clientesIM.find((c: any) => Number(c.cod_cliente) === codCliente);
      if (!cli || Number(cli.cod_vendedor) !== Number(user.cod_vendedor)) {
        res.status(403).json({ error: 'Cliente no pertenece al vendedor' });
        return;
      }
    }

    const periodos = ultimosMeses(meses);
    const fetches = periodos.flatMap(p => [getMonthlyVentasRaw(p.year, p.month), getMonthlyItemsRaw(p.year, p.month)]);
    const articulosMap = await fetchArticulosCatalogo();
    const results = await Promise.all(fetches);

    const ventasAll: any[] = [];
    const itemsAll: any[] = [];
    for (let i = 0; i < periodos.length; i++) {
      const v = results[i * 2] as Awaited<ReturnType<typeof getMonthlyVentasRaw>>;
      const it = results[i * 2 + 1] as Awaited<ReturnType<typeof getMonthlyItemsRaw>>;
      ventasAll.push(...v.ventas);
      itemsAll.push(...it.items);
    }

    const cabsValidas = new Map<number, any>();
    const signosParaAgg = new Map<number, { sign: 1 | -1; fecha: string }>();

    for (const v of ventasAll) {
      const id = Number(v.id);
      if (!Number.isFinite(id)) continue;
      const codEmp = Number(v.cod_empresa);
      if (Number.isFinite(codEmp) && codEmp !== COD_EMPRESA_CASA_CENTRAL) continue;
      const codCli = Number(v.cod_cliente);
      if (codCli !== codCliente) continue;
      if (COD_CLIENTES_INTERNOS.has(codCli)) continue;
      const clase = clasificarCabecera(v);
      if (!clase) continue;
      const sign: 1 | -1 = clase === 'NC' ? -1 : 1;
      const fecha = String(v.fecha ?? v.fa_fecha ?? '').slice(0, 10);

      cabsValidas.set(id, {
        id,
        fecha,
        tipo: tipoComprobante(v),
        tipo_factura: (v as any).tipo_factura ?? tipoComprobante(v),
        punto_de_venta: v.punto_de_venta,
        numero: v.numero,
        fa_total: Number(v.fa_total ?? v.total ?? 0),
        sign,
      });
      signosParaAgg.set(id, { sign, fecha });
    }

    const itemsLimpios = itemsAll.filter(it => {
      const detalle = String((it as any).detalle ?? articulosMap.get(Number(it.cod_articulo))?.descripcion ?? '');
      return !esLineaTecnica(detalle);
    });

    const agg = agregarPorArticulo(itemsLimpios, signosParaAgg, articulosMap);
    const top_importe = topPorImporte(agg, 5);
    const top_frecuencia = topPorFrecuencia(agg, 5);
    const facturas = armarFacturas(cabsValidas, itemsAll, articulosMap);

    const desde = `${periodos[periodos.length - 1].year}-${String(periodos[periodos.length - 1].month).padStart(2, '0')}-01`;
    const lastMes = new Date(periodos[0].year, periodos[0].month, 0);
    const hasta = `${periodos[0].year}-${String(periodos[0].month).padStart(2, '0')}-${String(lastMes.getDate()).padStart(2, '0')}`;

    res.json({
      ok: true,
      cod_cliente: codCliente,
      meses,
      rango: { desde, hasta },
      facturas,
      top_importe,
      top_frecuencia,
      generated_at: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('historialComprasCliente error:', err);
    res.status(500).json({ ok: false, error: err?.message ?? 'error' });
  }
}
```

- [ ] **Step 2: Verificar que compila**

Run: `npm run build:server`
Expected: build OK sin errores.

- [ ] **Step 3: Commit**

```bash
git add server-lib/historialCompras.ts
git commit -m "feat(historial-compras): handler endpoint con permisos y agregación"
```

---

## Task 6: Registrar la ruta en `server.ts`

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Encontrar línea donde registrar la ruta**

Buscar la línea donde está `/api/clientes/lookup`:

```bash
grep -n "/api/clientes/lookup" server.ts
```

Expected: `server.ts:705:app.get('/api/clientes/lookup', requireJwt, (req: any, res) => listClientesLookup(req, res));`

- [ ] **Step 2: Agregar import + ruta**

Editar `server.ts`:

En la sección de imports (donde están otros imports de server-lib, buscar `import { listClientesLookup }`):

```ts
import { historialComprasCliente } from './server-lib/historialCompras.js';
```

Después de la línea `app.get('/api/clientes/lookup', ...)`:

```ts
app.get('/api/clientes/:cod/historial-compras', requireJwt, (req: any, res) => historialComprasCliente(req, res));
```

- [ ] **Step 3: Build + verificar**

Run: `npm run build:server`
Expected: build OK.

- [ ] **Step 4: Smoke test manual (opcional pero recomendado)**

```bash
PORT=3001 npm run dev:server &
# En otra terminal:
curl -s "http://localhost:3001/api/clientes/1/historial-compras" | head -50
# Esperado: 401 (no token) o 200 con datos si seteás Authorization Bearer.
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add server.ts
git commit -m "feat(historial-compras): registrar ruta /api/clientes/:cod/historial-compras"
```

---

## Task 7: Frontend — tipos + hook de fetch

**Files:**
- Modify: `src/components/VendorShell.tsx`

- [ ] **Step 1: Agregar interfaces de tipo cerca de las otras (después de `ClienteObjetivoCard` definitions, antes de su uso)**

Buscar la interfaz `ClienteObjetivo` (línea ~87) y agregar después de las interfaces existentes, antes de `interface Props`:

```ts
interface HistorialItemAgregado {
    cod_articulo: number;
    detalle: string;
    cantidad_total: number;
    importe_total: number;
    num_facturas: number;
    ultima_compra: string;
}

interface HistorialFacturaItem {
    cod_articulo: number;
    detalle: string;
    cantidad: number;
    importe: number;
}

interface HistorialFactura {
    id_comprobante: number;
    fecha: string;
    tipo: 'FA' | 'NC';
    tipo_factura: string;
    punto_venta: number;
    numero: number;
    total_neto: number;
    items: HistorialFacturaItem[];
}

interface HistorialComprasResponse {
    ok: boolean;
    cod_cliente: number;
    meses: number;
    rango: { desde: string; hasta: string };
    facturas: HistorialFactura[];
    top_importe: HistorialItemAgregado[];
    top_frecuencia: HistorialItemAgregado[];
    generated_at: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/VendorShell.tsx
git commit -m "feat(historial-compras): tipos de historial en VendorShell"
```

---

## Task 8: Frontend — sub-componente `TopProductosCliente`

**Files:**
- Modify: `src/components/VendorShell.tsx`

- [ ] **Step 1: Agregar componente al final del archivo (antes de `export default` si existiera, o al final)**

```tsx
function TopProductosCliente({ topImporte, topFrecuencia }: { topImporte: HistorialItemAgregado[]; topFrecuencia: HistorialItemAgregado[] }) {
    if (topImporte.length === 0 && topFrecuencia.length === 0) return null;

    return (
        <div className="vs-historial-top">
            <h4>Top productos · últimos 3 meses</h4>
            <div className="vs-historial-top-grid">
                <div className="vs-historial-top-col">
                    <h5>Top por $</h5>
                    {topImporte.length === 0 ? (
                        <p className="vs-historial-empty">—</p>
                    ) : (
                        <ol className="vs-historial-top-list">
                            {topImporte.map((a, idx) => (
                                <li key={`imp-${a.cod_articulo}`}>
                                    <span className="rank">{idx + 1}.</span>
                                    <span className="det">{a.detalle}</span>
                                    <span className="meta">{formatMoney(a.importe_total)} · {a.num_facturas} fact</span>
                                </li>
                            ))}
                        </ol>
                    )}
                </div>
                <div className="vs-historial-top-col">
                    <h5>Más habitual</h5>
                    {topFrecuencia.length === 0 ? (
                        <p className="vs-historial-empty">—</p>
                    ) : (
                        <ol className="vs-historial-top-list">
                            {topFrecuencia.map((a, idx) => (
                                <li key={`frec-${a.cod_articulo}`}>
                                    <span className="rank">{idx + 1}.</span>
                                    <span className="det">{a.detalle}</span>
                                    <span className="meta">{a.num_facturas} fact · {a.cantidad_total} u.</span>
                                </li>
                            ))}
                        </ol>
                    )}
                </div>
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Verificar que el archivo compila**

Run: `npm run build`
Expected: build OK (puede haber unused warning del componente nuevo, está bien).

- [ ] **Step 3: Commit**

```bash
git add src/components/VendorShell.tsx
git commit -m "feat(historial-compras): componente TopProductosCliente"
```

---

## Task 9: Frontend — sub-componente `ComprasRecientesCliente`

**Files:**
- Modify: `src/components/VendorShell.tsx`

- [ ] **Step 1: Agregar componente después de `TopProductosCliente`**

```tsx
function ComprasRecientesCliente({ facturas }: { facturas: HistorialFactura[] }) {
    const [verTodas, setVerTodas] = useState(false);
    const [openComp, setOpenComp] = useState<number | null>(null);
    const limite = 10;
    const mostradas = verTodas ? facturas : facturas.slice(0, limite);

    if (facturas.length === 0) return null;

    return (
        <div className="vs-historial-facturas">
            <h4>Compras recientes · últimos 3 meses</h4>
            <ul className="vs-historial-facturas-list">
                {mostradas.map(f => (
                    <li
                        key={f.id_comprobante}
                        className={`vs-factura-row ${f.tipo === 'NC' ? 'is-nc' : ''} ${openComp === f.id_comprobante ? 'is-open' : ''}`}
                    >
                        <button
                            type="button"
                            className="vs-factura-head"
                            onClick={() => setOpenComp(p => p === f.id_comprobante ? null : f.id_comprobante)}
                        >
                            <span className="fecha">{formatFechaCorta(f.fecha)}</span>
                            <span className="ref">
                                {f.tipo}{f.tipo_factura ? `-${f.tipo_factura}` : ''} {String(f.punto_venta).padStart(4, '0')}-{String(f.numero).padStart(8, '0')}
                            </span>
                            <span className="monto">{formatMoney(f.total_neto)}</span>
                        </button>
                        {openComp === f.id_comprobante && f.items.length > 0 && (
                            <ul className="vs-factura-items">
                                {f.items.map((it, idx) => (
                                    <li key={`${f.id_comprobante}-${idx}`}>
                                        <span className="det">{it.detalle}</span>
                                        <span className="cant">×{it.cantidad}</span>
                                        <span className="imp">{formatMoney(it.importe)}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                        {openComp === f.id_comprobante && f.items.length === 0 && (
                            <p className="vs-factura-items-empty">Sin desglose disponible</p>
                        )}
                    </li>
                ))}
            </ul>
            {!verTodas && facturas.length > limite && (
                <button type="button" className="vs-historial-ver-todas" onClick={() => setVerTodas(true)}>
                    Ver todas ({facturas.length})
                </button>
            )}
        </div>
    );
}

function formatFechaCorta(iso: string): string {
    if (!iso || iso.length < 10) return iso ?? '';
    return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}
```

- [ ] **Step 2: Verificar build**

Run: `npm run build`
Expected: OK.

- [ ] **Step 3: Commit**

```bash
git add src/components/VendorShell.tsx
git commit -m "feat(historial-compras): componente ComprasRecientesCliente"
```

---

## Task 10: Frontend — integrar en `ClienteObjetivoCard`

**Files:**
- Modify: `src/components/VendorShell.tsx`

- [ ] **Step 1: Modificar `ClienteObjetivoCard`**

Buscar la función `function ClienteObjetivoCard(...)` (línea ~1612). Agregar dentro del componente, después de los cálculos de `statusCfg`, el state + fetch:

```tsx
const [histLoading, setHistLoading] = useState(false);
const [histErr, setHistErr] = useState<string | null>(null);
const [histData, setHistData] = useState<HistorialComprasResponse | null>(null);
const [histRequested, setHistRequested] = useState(false);

const loadHist = async () => {
    setHistLoading(true);
    setHistErr(null);
    try {
        const res = await fetch(`/api/clientes/${c.cod_cliente}/historial-compras?meses=3`, { headers: authHeaders() });
        const j = await res.json();
        if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
        setHistData(j);
    } catch (e: any) {
        setHistErr(e.message);
    } finally {
        setHistLoading(false);
    }
};

useEffect(() => {
    if (isOpen && !histRequested) {
        setHistRequested(true);
        loadHist();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
}, [isOpen]);
```

Cambiar `canExpand` para que sea siempre `true` (el cliente siempre puede tener historial):

Buscar:
```ts
const canExpand = hasInfoComercial || hasHistorico;
```

Reemplazar por:
```ts
const canExpand = true;
```

Dentro del bloque `{isOpen && canExpand && (...)}` (alrededor de línea 1664), después del bloque de `hasHistorico`, agregar la sección historial. Buscar el cierre del bloque `{hasHistorico && (...)}` que termina cerca de línea 1689, y antes del `</div>` de cierre del `vs-cliente-obj-detail`:

```tsx
{histLoading && (
    <div className="vs-historial-loading">
        <Loader2 size={14} className="spin" /> Cargando historial…
    </div>
)}
{histErr && (
    <div className="vs-historial-error">
        No se pudieron cargar las compras.
        <button type="button" onClick={loadHist}>Reintentar</button>
    </div>
)}
{histData && histData.facturas.length === 0 && (
    <p className="vs-historial-empty-state">Sin compras registradas en los últimos 3 meses.</p>
)}
{histData && histData.facturas.length > 0 && (
    <>
        <TopProductosCliente topImporte={histData.top_importe} topFrecuencia={histData.top_frecuencia} />
        <ComprasRecientesCliente facturas={histData.facturas} />
    </>
)}
```

Asegurarse de que `useEffect` esté importado en la línea 1 de imports (ya debería estar, verificar):

```ts
import { useEffect, useState } from 'react';
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: OK.

- [ ] **Step 3: Commit**

```bash
git add src/components/VendorShell.tsx
git commit -m "feat(historial-compras): integrar TopProductos y ComprasRecientes en ClienteObjetivoCard"
```

---

## Task 11: Estilos CSS

**Files:**
- Modify: `src/components/VendorShell.css`

- [ ] **Step 1: Agregar al final del archivo**

```css
/* ─── Historial de compras por cliente ───────────────────────────── */

.vs-historial-loading,
.vs-historial-error {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 8px;
    color: #6B7280;
    font-size: 13px;
}

.vs-historial-error button {
    background: none;
    border: 1px solid #A83E2B;
    color: #A83E2B;
    padding: 4px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
}

.vs-historial-empty-state {
    padding: 12px 8px;
    color: #6B7280;
    font-style: italic;
    margin: 0;
    font-size: 13px;
}

.vs-historial-top {
    margin-top: 14px;
}

.vs-historial-top h4 {
    margin: 0 0 8px;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #6B7280;
}

.vs-historial-top-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 12px;
}

@media (max-width: 480px) {
    .vs-historial-top-grid {
        grid-template-columns: 1fr;
    }
}

.vs-historial-top-col h5 {
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 600;
    color: #06652F;
    text-transform: uppercase;
    letter-spacing: 0.4px;
}

.vs-historial-top-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.vs-historial-top-list li {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    grid-template-rows: auto auto;
    column-gap: 4px;
    align-items: baseline;
    font-size: 12px;
    min-width: 0;
}

.vs-historial-top-list .rank {
    grid-column: 1;
    grid-row: 1 / span 2;
    color: #9CA3AF;
    font-weight: 600;
}

.vs-historial-top-list .det {
    grid-column: 2;
    grid-row: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
}

.vs-historial-top-list .meta {
    grid-column: 2;
    grid-row: 2;
    color: #6B7280;
    font-size: 11px;
}

.vs-historial-empty {
    color: #9CA3AF;
    font-size: 12px;
    margin: 0;
}

.vs-historial-facturas {
    margin-top: 14px;
}

.vs-historial-facturas h4 {
    margin: 0 0 8px;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #6B7280;
}

.vs-historial-facturas-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.vs-factura-row.is-nc .vs-factura-head .monto {
    color: #A83E2B;
}

.vs-factura-row.is-nc .vs-factura-head .ref {
    color: #A83E2B;
}

.vs-factura-head {
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr) auto;
    gap: 8px;
    width: 100%;
    background: none;
    border: 0;
    padding: 8px 6px;
    cursor: pointer;
    text-align: left;
    font-size: 13px;
    border-radius: 6px;
    align-items: center;
}

.vs-factura-head:hover {
    background: rgba(0, 0, 0, 0.03);
}

.vs-factura-head .fecha {
    color: #6B7280;
    font-variant-numeric: tabular-nums;
}

.vs-factura-head .ref {
    color: #374151;
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.vs-factura-head .monto {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
}

.vs-factura-items {
    list-style: none;
    padding: 4px 8px 8px 64px;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    border-bottom: 1px dashed rgba(0, 0, 0, 0.08);
}

.vs-factura-items li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 8px;
    font-size: 12px;
    color: #4B5563;
    align-items: baseline;
}

.vs-factura-items .det {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.vs-factura-items .cant {
    color: #6B7280;
    font-variant-numeric: tabular-nums;
}

.vs-factura-items .imp {
    font-variant-numeric: tabular-nums;
    text-align: right;
}

.vs-factura-items-empty {
    padding: 4px 8px 8px 64px;
    margin: 0;
    color: #9CA3AF;
    font-style: italic;
    font-size: 12px;
}

.vs-historial-ver-todas {
    margin-top: 8px;
    background: none;
    border: 1px solid #06652F;
    color: #06652F;
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
}

.vs-historial-ver-todas:hover {
    background: rgba(6, 101, 47, 0.08);
}
```

- [ ] **Step 2: Build + smoke local**

Run: `npm run build`
Expected: OK.

Run local en dev (en otra terminal):

```bash
npm run dev
```

Abrir `http://localhost:5173`, loguear como vendedor, ir a Objetivos, expandir un cliente con compras → verificar visualmente que se ven los rankings y la lista. Cerrar dev (`Ctrl+C`).

- [ ] **Step 3: Commit**

```bash
git add src/components/VendorShell.css
git commit -m "feat(historial-compras): estilos para top productos y compras recientes"
```

---

## Task 12: Test E2E Playwright

**Files:**
- Create: `tests/historial-compras.spec.ts`

- [ ] **Step 1: Crear test que valida el render del historial**

`tests/historial-compras.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

/**
 * Validación de la vista de historial de compras dentro del expand de
 * un cliente en la tab Objetivos.
 *
 * Auth: necesita un JWT válido en localStorage (mismo enfoque que
 * recibos-debug.spec.ts y vendor-overflow.spec.ts).
 *
 * Setear vía variable de entorno o hardcodear con un token local:
 *   E2E_JWT=eyJ... npx playwright test historial-compras
 */

const JWT = process.env.E2E_JWT;

test.skip(!JWT, 'Necesita E2E_JWT para correr');

test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate((t) => localStorage.setItem('token', t!), JWT!);
});

test('vendedor expande un cliente y ve top productos + compras recientes', async ({ page }) => {
    await page.goto('/');
    // Ir a la tab Objetivos
    await page.getByRole('button', { name: /objetivos/i }).click();

    // Esperar lista de clientes
    await page.waitForSelector('.vs-cliente-obj', { timeout: 15000 });

    // Expandir el primer cliente
    const firstCliente = page.locator('.vs-cliente-obj').first();
    await firstCliente.locator('.vs-cliente-obj-head').click();

    // Validar que aparece la sección de historial (loading o cargada)
    await expect(firstCliente.locator('.vs-historial-loading, .vs-historial-top, .vs-historial-empty-state')).toBeVisible({ timeout: 10000 });

    // Si no es empty state, debería haber al menos una factura
    const isEmpty = await firstCliente.locator('.vs-historial-empty-state').isVisible();
    if (!isEmpty) {
        await expect(firstCliente.locator('.vs-historial-top')).toBeVisible({ timeout: 15000 });
        await expect(firstCliente.locator('.vs-historial-facturas')).toBeVisible();
    }
});

test('expandir y colapsar no refetchea (cache local del componente)', async ({ page }) => {
    let fetchCount = 0;
    await page.route('**/api/clientes/*/historial-compras*', (route) => {
        fetchCount++;
        route.continue();
    });

    await page.goto('/');
    await page.getByRole('button', { name: /objetivos/i }).click();
    await page.waitForSelector('.vs-cliente-obj', { timeout: 15000 });
    const firstCliente = page.locator('.vs-cliente-obj').first();

    // Abrir
    await firstCliente.locator('.vs-cliente-obj-head').click();
    await page.waitForTimeout(2000);
    expect(fetchCount).toBe(1);

    // Cerrar
    await firstCliente.locator('.vs-cliente-obj-head').click();
    await page.waitForTimeout(500);

    // Abrir de nuevo
    await firstCliente.locator('.vs-cliente-obj-head').click();
    await page.waitForTimeout(1500);
    expect(fetchCount).toBe(1); // sigue siendo 1, no refetcheó
});
```

- [ ] **Step 2: Sumar el test al config de iphone-edge para validar mobile**

Editar `playwright.config.ts`, en el bloque `iphone-edge.testMatch` agregar el nuevo archivo:

```ts
testMatch: /(recibos-debug|vendor-overflow|historial-compras)\.spec\.ts/,
```

Y mantenerlo fuera del bloque `iphone-13.testIgnore` agregándolo ahí también:

```ts
testIgnore: /(recibos-debug|vendor-overflow|historial-compras)\.spec\.ts/,
```

- [ ] **Step 3: Correr el test si hay JWT disponible**

Run (si tenés un JWT):
```bash
E2E_JWT="eyJ..." npx playwright test historial-compras --project=iphone-edge
```

Expected: PASS (o SKIP si no hay JWT).

- [ ] **Step 4: Commit**

```bash
git add tests/historial-compras.spec.ts playwright.config.ts
git commit -m "test(historial-compras): E2E Playwright + soporte mobile"
```

---

## Task 13: Push del branch y PR

**Files:** —

- [ ] **Step 1: Push del branch**

```bash
git push -u origin feat/cliente-historial-compras
```

- [ ] **Step 2: Crear PR (vía gh CLI)**

```bash
gh pr create --title "feat: historial de compras por cliente en panel del vendedor" --body "$(cat <<'EOF'
## Summary

- Endpoint nuevo `GET /api/clientes/:cod/historial-compras?meses=3` que reusa el cache mensual de ventas+items para devolver últimas facturas y top productos del cliente.
- UI dentro del expand de `ClienteObjetivoCard` (tab Objetivos): dos rankings (top por \$ + más habituales) + lista plegada de hasta 10 últimas facturas con desglose al tocar.
- Lazy fetch al expandir la primera vez; no se refetchea al abrir/cerrar.
- Notas de crédito restan del top y aparecen en rojo en la lista.
- Líneas técnicas (flete, descuento, bonif, ajuste, redondeo, percepción) excluidas de top y de items de factura.
- Repartidor NO accede (403). Vendedor solo sus clientes.

Spec: `docs/superpowers/specs/2026-05-25-historial-compras-cliente-design.md`
Plan: `docs/superpowers/plans/2026-05-25-historial-compras-cliente.md`

## Test plan

- [ ] Unit tests pasan: `npx vitest run server-lib/historialCompras.test.ts`
- [ ] Build OK: `npm run build`
- [ ] Smoke local: login vendedor → tab Objetivos → expandir cliente con compras → ver top + facturas
- [ ] Smoke local: cliente sin compras → empty state
- [ ] Smoke local: NC visible en rojo
- [ ] E2E Playwright (con JWT): `E2E_JWT=... npx playwright test historial-compras`
- [ ] Mobile iPhone 17e: sin overflow horizontal en la sección nueva
- [ ] Producción post-deploy: validar con un cliente real que los números cuadran contra IM directo

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Verificar PR creado**

Run: `gh pr view`
Expected: muestra el PR con título y body.

---

## Self-review checklist

- [x] **Spec coverage:** cada sección del spec tiene tasks. Backend (Task 1-6) cubre filtros, agregación, permisos y endpoint. Frontend (Task 7-11) cubre tipos, sub-componentes, integración en card, CSS. Tests (Task 12) cubre E2E + mobile.
- [x] **Repartidor sin acceso:** explícito en Task 5 (`if (user.rol !== 'admin' && user.rol !== 'gerente' && user.rol !== 'vendedor') return 403`).
- [x] **Exclusión técnica:** Task 1 implementa los patrones del spec exactos.
- [x] **NCs:** Task 4 y 5 las marcan con signo negativo en items y total, Task 9 las muestra con clase `is-nc`, Task 11 las pinta en rojo.
- [x] **Lazy load:** Task 10 fetchea solo cuando `isOpen` cambia a true por primera vez.
- [x] **Mobile:** CSS de Task 11 usa `minmax(0,1fr)` (evita el bug que ya pasamos el 20/05) y media query para apilar columnas en <480px. Task 12 corre el test en `iphone-edge`.
- [x] **Empty state:** Task 10 lo renderiza cuando `facturas.length === 0`.
- [x] **Errores no rompen el resto:** Task 10 muestra error con botón "Reintentar" sin afectar `Info comercial` ni `Histórico`.
- [x] **Tipos consistentes:** `HistorialItemAgregado` y `AgregadoArticulo` tienen los mismos campos. `HistorialFactura` matchea `FacturaHistorial` del backend.
- [x] **No placeholders:** repasado, no hay TBDs.

---

## Notes

- Si durante la implementación aparece un campo nuevo en `VentaItem` que el código no contempla, agregarlo a `infomanager.ts` y al tipo correspondiente.
- Si el handler tira 500 en producción, revisar los logs por si `fetchClientesIMCached` falla — el fallback debería ser dejar pasar al vendedor (decidir en review si conviene fail-open o fail-closed para este caso; actualmente está fail-closed).
- Si emerge un patrón técnico nuevo (caso real: aparece "ENVASE RETORNABLE" como ítem técnico), agregarlo a `PATRONES_LINEA_TECNICA` en `historialCompras.ts` y mergear.
