import { describe, it, expect } from 'vitest';
import {
  esLineaTecnica,
  agregarPorArticulo,
  topPorImporte,
  topPorFrecuencia,
  armarFacturas,
  calcularAlertaCliente,
  detectarProductosAbandono,
  calcularComparacionTrimestre,
  type FacturaHistorial,
} from './historialCompras.js';

// Helper para tests: crea una factura FA con fecha + lista de items.
function makeFA(id: number, fecha: string, items: Array<{ cod_articulo: number; detalle: string; cantidad?: number; importe?: number }> = [], total_neto = 1000): FacturaHistorial {
  return {
    id_comprobante: id, fecha, tipo: 'FA', tipo_factura: 'A', punto_venta: 1, numero: id, total_neto,
    items: items.map(i => ({ cod_articulo: i.cod_articulo, detalle: i.detalle, cantidad: i.cantidad ?? 1, importe: i.importe ?? 100 })),
  };
}
function makeNC(id: number, fecha: string, total_neto = -500): FacturaHistorial {
  return { id_comprobante: id, fecha, tipo: 'NC', tipo_factura: 'A', punto_venta: 1, numero: id, total_neto, items: [] };
}

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

describe('calcularAlertaCliente', () => {
  const ahora = new Date('2026-05-30T00:00:00Z');

  it('null si menos de 3 facturas (poca data)', () => {
    expect(calcularAlertaCliente([], ahora)).toBeNull();
    expect(calcularAlertaCliente([makeFA(1, '2026-05-01')], ahora)).toBeNull();
    expect(calcularAlertaCliente([makeFA(1, '2026-05-01'), makeFA(2, '2026-05-10')], ahora)).toBeNull();
  });

  it('null si cliente compra con frecuencia normal', () => {
    // Cada ~12 días, última hace 8 días: dentro del rango normal
    const facturas = [
      makeFA(1, '2026-04-10'),
      makeFA(2, '2026-04-22'),
      makeFA(3, '2026-05-05'),
      makeFA(4, '2026-05-22'),
    ];
    const r = calcularAlertaCliente(facturas, ahora);
    expect(r?.nivel).toBeNull();
  });

  it('amarillo cuando supera 2x la media', () => {
    // Media ~12 días, última hace 28 días (>2x media)
    const facturas = [
      makeFA(1, '2026-03-30'),
      makeFA(2, '2026-04-12'),
      makeFA(3, '2026-04-25'),
      makeFA(4, '2026-05-02'),
    ];
    const r = calcularAlertaCliente(facturas, ahora);
    expect(r?.nivel).toBe('amarillo');
    expect(r?.dias_sin_comprar).toBe(28);
  });

  it('rojo cuando supera 3x la media', () => {
    // Media ~10 días, última hace 50 días (>3x media)
    const facturas = [
      makeFA(1, '2026-03-05'),
      makeFA(2, '2026-03-15'),
      makeFA(3, '2026-03-25'),
      makeFA(4, '2026-04-10'),
    ];
    const r = calcularAlertaCliente(facturas, ahora);
    expect(r?.nivel).toBe('rojo');
  });

  it('ignora NCs para el cálculo de "ritmo de compra"', () => {
    // Solo cuenta FAs. Una NC el día 28 no debería cambiar el último día de compra.
    const facturas = [
      makeFA(1, '2026-03-30'),
      makeFA(2, '2026-04-12'),
      makeFA(3, '2026-04-25'),
      makeFA(4, '2026-05-02'),
      makeNC(99, '2026-05-25'), // devolución reciente, no compra
    ];
    const r = calcularAlertaCliente(facturas, ahora);
    expect(r?.dias_sin_comprar).toBe(28); // 30/05 - 02/05 = 28
  });
});

describe('detectarProductosAbandono', () => {
  const ahora = new Date('2026-05-30T00:00:00Z');

  it('detecta producto habitual no comprado hace >2x su intervalo medio', () => {
    // Mix Energético: aparece en 4 facturas con intervalo medio ~14 días.
    // Última vez 2026-04-01 → 59 días sin comprar (>2× 14)
    const facturas = [
      makeFA(1, '2026-02-15', [{ cod_articulo: 100, detalle: 'Mix Energético' }]),
      makeFA(2, '2026-03-01', [{ cod_articulo: 100, detalle: 'Mix Energético' }]),
      makeFA(3, '2026-03-15', [{ cod_articulo: 100, detalle: 'Mix Energético' }]),
      makeFA(4, '2026-04-01', [{ cod_articulo: 100, detalle: 'Mix Energético' }]),
      // Después: facturas pero sin Mix
      makeFA(5, '2026-04-20', [{ cod_articulo: 200, detalle: 'Tiernitos' }]),
      makeFA(6, '2026-05-15', [{ cod_articulo: 200, detalle: 'Tiernitos' }]),
    ];
    const r = detectarProductosAbandono(facturas, ahora);
    expect(r.length).toBeGreaterThan(0);
    const mix = r.find(p => p.cod_articulo === 100);
    expect(mix).toBeDefined();
    expect(mix!.detalle).toBe('Mix Energético');
    expect(mix!.dias_sin_comprar).toBe(59);
  });

  it('skipea productos con menos de 3 apariciones (no habitual)', () => {
    const facturas = [
      makeFA(1, '2026-02-15', [{ cod_articulo: 100, detalle: 'Mix Energético' }]),
      makeFA(2, '2026-03-01', [{ cod_articulo: 100, detalle: 'Mix Energético' }]),
      // Solo 2 apariciones → no habitual
    ];
    const r = detectarProductosAbandono(facturas, ahora);
    expect(r.find(p => p.cod_articulo === 100)).toBeUndefined();
  });

  it('skipea productos comprados recientemente (sin abandono)', () => {
    // Producto comprado cada ~14 días, último hace 10 días (no es abandono)
    const facturas = [
      makeFA(1, '2026-04-20', [{ cod_articulo: 100, detalle: 'X' }]),
      makeFA(2, '2026-05-04', [{ cod_articulo: 100, detalle: 'X' }]),
      makeFA(3, '2026-05-20', [{ cod_articulo: 100, detalle: 'X' }]), // 10 días atrás
    ];
    const r = detectarProductosAbandono(facturas, ahora);
    expect(r).toEqual([]);
  });

  it('ignora NCs (no cuentan como compra del producto)', () => {
    const facturas = [
      makeFA(1, '2026-02-15', [{ cod_articulo: 100, detalle: 'X' }]),
      makeFA(2, '2026-03-01', [{ cod_articulo: 100, detalle: 'X' }]),
      makeFA(3, '2026-03-15', [{ cod_articulo: 100, detalle: 'X' }]),
      makeNC(99, '2026-05-25', /* total */ -500), // NC reciente, no cuenta
    ];
    const r = detectarProductosAbandono(facturas, ahora);
    const x = r.find(p => p.cod_articulo === 100);
    expect(x).toBeDefined();
    // dias_sin_comprar tiene que ser desde 2026-03-15, no desde 2026-05-25
    expect(x!.dias_sin_comprar).toBeGreaterThan(70);
  });

  it('ordena por recencia: lo recién caído primero (más recuperable arriba)', () => {
    const facturas = [
      // Producto A: última hace 21 días (2026-05-09), cruza abr/may → recuperable
      makeFA(1, '2026-04-25', [{ cod_articulo: 1, detalle: 'A' }]),
      makeFA(2, '2026-05-02', [{ cod_articulo: 1, detalle: 'A' }]),
      makeFA(3, '2026-05-09', [{ cod_articulo: 1, detalle: 'A' }]),

      // Producto B: última hace 56 días (2026-04-04), cruza feb/mar/abr → más viejo
      makeFA(4, '2026-02-20', [{ cod_articulo: 2, detalle: 'B' }]),
      makeFA(5, '2026-03-06', [{ cod_articulo: 2, detalle: 'B' }]),
      makeFA(6, '2026-03-20', [{ cod_articulo: 2, detalle: 'B' }]),
      makeFA(7, '2026-04-04', [{ cod_articulo: 2, detalle: 'B' }]),
    ];
    const r = detectarProductosAbandono(facturas, ahora);
    // A cayó hace 21 días (más recuperable) → primero; B hace 56 → después.
    expect(r[0].cod_articulo).toBe(1);
    expect(r[1].cod_articulo).toBe(2);
  });

  it('oculta productos abandonados hace más del tope (90 días): ya se consideran perdidos', () => {
    // Habitual que cruza ene/feb pero cuya última compra fue hace 100 días (2026-02-19).
    const facturas = [
      makeFA(1, '2026-01-05', [{ cod_articulo: 100, detalle: 'Perdido' }]),
      makeFA(2, '2026-02-01', [{ cod_articulo: 100, detalle: 'Perdido' }]),
      makeFA(3, '2026-02-19', [{ cod_articulo: 100, detalle: 'Perdido' }]),
    ];
    // 2026-02-19 → 2026-05-30 = 100 días sin comprar (> 90)
    const r = detectarProductosAbandono(facturas, ahora);
    expect(r.find(p => p.cod_articulo === 100)).toBeUndefined();
  });

  it('mantiene abandono reciente dentro del tope (≤90 días sí se muestra)', () => {
    // Misma forma pero última compra hace 72 días (2026-03-19), bajo el tope.
    const facturas = [
      makeFA(1, '2026-02-01', [{ cod_articulo: 100, detalle: 'Recuperable' }]),
      makeFA(2, '2026-02-20', [{ cod_articulo: 100, detalle: 'Recuperable' }]),
      makeFA(3, '2026-03-19', [{ cod_articulo: 100, detalle: 'Recuperable' }]),
    ];
    const r = detectarProductosAbandono(facturas, ahora);
    expect(r.find(p => p.cod_articulo === 100)).toBeDefined();
  });

  it('no marca ráfagas: 3 compras en un mismo mes no son "hábito" aunque haya días sin comprar', () => {
    // Todas en marzo → no cruzan 2 meses calendario distintos (promo / entrega partida).
    const facturas = [
      makeFA(1, '2026-03-02', [{ cod_articulo: 100, detalle: 'Promo puntual' }]),
      makeFA(2, '2026-03-10', [{ cod_articulo: 100, detalle: 'Promo puntual' }]),
      makeFA(3, '2026-03-18', [{ cod_articulo: 100, detalle: 'Promo puntual' }]),
    ];
    const r = detectarProductosAbandono(facturas, ahora);
    expect(r.find(p => p.cod_articulo === 100)).toBeUndefined();
  });
});

describe('calcularComparacionTrimestre', () => {
  it('calcula sumas y delta porcentual', () => {
    const actual = [makeFA(1, '2026-05-01', [], 800000), makeFA(2, '2026-05-15', [], 650000)]; // 1450k
    const anterior = [makeFA(3, '2026-02-01', [], 700000), makeFA(4, '2026-02-20', [], 550000)]; // 1250k
    const r = calcularComparacionTrimestre(actual, anterior);
    expect(r.actual).toBe(1450000);
    expect(r.anterior).toBe(1250000);
    expect(r.delta_pct).toBeCloseTo(0.16, 2);
  });

  it('NCs restan en cada trimestre (total_neto ya viene con signo)', () => {
    const actual = [makeFA(1, '2026-05-01', [], 1000), makeNC(2, '2026-05-10', -300)];
    const r = calcularComparacionTrimestre(actual, []);
    expect(r.actual).toBe(700);
  });

  it('delta_pct = null si trimestre anterior es 0', () => {
    const actual = [makeFA(1, '2026-05-01', [], 1000)];
    const r = calcularComparacionTrimestre(actual, []);
    expect(r.delta_pct).toBeNull();
  });

  it('trimestre actual vacío → 0 / 0 / null', () => {
    const r = calcularComparacionTrimestre([], []);
    expect(r.actual).toBe(0);
    expect(r.anterior).toBe(0);
    expect(r.delta_pct).toBeNull();
  });
});
