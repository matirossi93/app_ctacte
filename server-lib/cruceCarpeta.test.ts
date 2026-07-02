import { describe, it, expect, vi } from 'vitest';
import * as XLSX from 'xlsx';

// cruceCarpeta.ts importa conciliacion.js, que a su vez importa infomanager.js
// (process.exit si falta el secret) y supabase.js. Mockeamos SOLO esas hojas
// con side-effects; conciliacion.js se carga real (clasificarRecibos real).
vi.mock('./infomanager.js', () => ({
  fetchComprobPendientes: vi.fn(),
  fetchClientesIMCached: vi.fn(),
  fetchVendedores: vi.fn(),
}));
vi.mock('./supabase.js', () => ({
  sb: vi.fn(),
  TENANT_ID: 'test-tenant',
  hasSupabase: () => true,
}));

import {
  normalizarNombre,
  scoreNombres,
  parseFechaCarpeta,
  parseMontoCarpeta,
  parseTolerancia,
  parseCarpeta,
  resolverLadoSistema,
  cruzarVendedor,
  cruzarCarpeta,
  UMBRAL_MATCH,
  TOLERANCIA_DEFAULT,
  PESTANA_OTROS,
  type ClienteCarpeta,
  type ClienteSistema,
  type CarpetaParseada,
} from './cruceCarpeta.js';
import type { PendienteIM, ClienteMaestro, ReciboTransito, MaestroSnapshot } from './conciliacion.js';

/**
 * Tests del motor de cruce carpeta vs sistema. Los casos vienen del cruce
 * REAL de junio 2026: DANTE/DONET (falso match del greedy ingenuo), MONTERO
 * (cliente anotado en la carpeta de un vendedor pero asignado a otro en IM),
 * SARACHO (typo de fecha 21/11/2026 con saldo correcto), SUPER EMANUEL
 * (carpeta $730k vs IM ~$0 — la diferencia que el cruce DEBE gritar).
 */

const CORTE = '2026-06-30';

// Serial de Excel para una fecha UTC dada (días desde 1899-12-30).
function serialExcel(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d) / 86400000 + 25569;
}

function wbCarpeta(pestanas: Record<string, any[][]>): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  for (const [nombre, filas] of Object.entries(pestanas)) {
    // fila 1 título + fila 2 headers, datos desde fila 3 (como el Sheet real)
    const aoa = [['CARPETA JUNIO'], ['FECHA', 'CLIENTE', 'SALDO'], ...filas];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), nombre);
  }
  return wb;
}

function cs(cod: number, nombre: string, saldo: number, codVend: number | null = 3): ClienteSistema {
  return { cod_cliente: cod, nombre, saldo, cod_vendedor: codVend };
}
function cc(nombre: string, saldo: number): ClienteCarpeta {
  return { nombre, saldo, n_filas: 1 };
}
function carpetaDe(vendedores: CarpetaParseada['vendedores']): CarpetaParseada {
  return { vendedores, excluidas_por_fecha: [], sin_fecha: [], pestanas_ignoradas: [] };
}

describe('normalización y scoring de nombres', () => {
  it("'CORDOBA, David  (Jujuy)' ≈ 'CORDOBA DAVID' con score ≥ 0.9", () => {
    expect(normalizarNombre('CORDOBA, David  (Jujuy)')).toBe('CORDOBA DAVID');
    expect(scoreNombres('CORDOBA, David  (Jujuy)', 'CORDOBA DAVID')).toBeGreaterThanOrEqual(0.9);
  });

  it("'DANTE' vs 'DONET' queda debajo del umbral de match", () => {
    expect(scoreNombres('DANTE', 'DONET')).toBeLessThan(UMBRAL_MATCH);
  });

  it('quita acentos y ñ vía NFD', () => {
    expect(normalizarNombre('Ñandú Pérez')).toBe('NANDU PEREZ');
  });
});

describe('parseFechaCarpeta / parseMontoCarpeta / parseTolerancia', () => {
  it('parsea serial de Excel, dd/mm/yyyy, dd/mm (año del corte) y rechaza typos', () => {
    expect(parseFechaCarpeta(serialExcel(2026, 6, 10), CORTE)).toBe('2026-06-10');
    expect(parseFechaCarpeta('21/11/2026', CORTE)).toBe('2026-11-21');
    expect(parseFechaCarpeta('05/06', CORTE)).toBe('2026-06-05');
    expect(parseFechaCarpeta('2*/05', CORTE)).toBeNull();
    expect(parseFechaCarpeta(null, CORTE)).toBeNull();
  });

  it("dd/mm que quedaría posterior al corte prueba el año ANTERIOR: '15/12' en cruce de enero", () => {
    // Corte enero 2026: '15/12' NO es typo, es diciembre 2025.
    expect(parseFechaCarpeta('15/12', '2026-01-31')).toBe('2025-12-15');
    // Mismo dd/mm con corte de fin de año: es diciembre del año del corte.
    expect(parseFechaCarpeta('15/12', '2026-12-31')).toBe('2026-12-15');
  });

  it('parsea montos number y string estilo AR', () => {
    expect(parseMontoCarpeta(1234.56)).toBe(1234.56);
    expect(parseMontoCarpeta('$ 1.234,56')).toBe(1234.56);
    expect(parseMontoCarpeta('1.234')).toBe(1234);       // punto de miles (formato AR)
    expect(parseMontoCarpeta('1234.5')).toBe(1234.5);    // punto decimal
    expect(parseMontoCarpeta('')).toBeNull();
  });

  it('tolerancia: vacío/undefined/no-numérico → default $20; solo negativo explícito se rechaza', () => {
    expect(parseTolerancia('')).toBe(TOLERANCIA_DEFAULT);      // Number('')===0 era el bug
    expect(parseTolerancia(undefined)).toBe(TOLERANCIA_DEFAULT);
    expect(parseTolerancia('abc')).toBe(TOLERANCIA_DEFAULT);
    expect(parseTolerancia('15')).toBe(15);
    expect(parseTolerancia(0)).toBe(0);                        // cero explícito es válido
    expect(parseTolerancia('-5')).toBeNull();                  // negativo → rechazar
  });
});

describe('parseCarpeta', () => {
  it('suma varias filas del mismo cliente (comprobantes) y saltea filas vacías', () => {
    const wb = wbCarpeta({
      JULIO: [
        ['01/06/2026', 'PEREZ JUAN', 1000],
        [null, null, null],                                  // fila vacía intercalada
        [serialExcel(2026, 6, 15), 'PEREZ JUAN', 500.5],     // serial Excel
        ['20/06/2026', 'GOMEZ ANA', '$ 2.000,00'],           // monto string AR
      ],
    });
    const out = parseCarpeta(wb, CORTE);

    expect(out.vendedores).toHaveLength(1);
    expect(out.vendedores[0].cod_vendedor).toBe(4); // JULIO
    const perez = out.vendedores[0].clientes.find(c => c.nombre === 'PEREZ JUAN')!;
    expect(perez.saldo).toBeCloseTo(1500.5, 2);
    expect(perez.n_filas).toBe(2);
    expect(out.vendedores[0].clientes.find(c => c.nombre === 'GOMEZ ANA')!.saldo).toBe(2000);
  });

  it('excluye filas con fecha > corte y las lista (caso SARACHO typo 21/11)', () => {
    const wb = wbCarpeta({
      MARCELO: [
        ['15/06/2026', 'LOPEZ MARIA', 800],
        ['21/11/2026', 'SARACHO', 5000],   // typo de fecha, saldo correcto
      ],
    });
    const out = parseCarpeta(wb, CORTE);

    expect(out.excluidas_por_fecha).toEqual([
      { vendedor: 'MARCELO', fila: 4, fecha: '2026-11-21', cliente: 'SARACHO', monto: 5000 },
    ]);
    expect(out.vendedores[0].clientes.map(c => c.nombre)).toEqual(['LOPEZ MARIA']);
  });

  it("una fila 'dd/12' en un cruce de enero cae al año anterior y SE INCLUYE", () => {
    const wb = wbCarpeta({ MARCELO: [['15/12', 'DICIEMBRE SRL', 4000]] });
    const out = parseCarpeta(wb, '2026-01-31');

    expect(out.excluidas_por_fecha).toHaveLength(0);
    expect(out.vendedores[0].clientes).toEqual([{ nombre: 'DICIEMBRE SRL', saldo: 4000, n_filas: 1 }]);
  });

  it("incluye filas sin fecha parseable ('2*/05') pero las lista en sin_fecha", () => {
    const wb = wbCarpeta({ SEBA: [['2*/05', 'LOPEZ RAUL', 300]] });
    const out = parseCarpeta(wb, CORTE);

    expect(out.sin_fecha).toEqual([
      { vendedor: 'SEBA', fila: 3, cliente: 'LOPEZ RAUL', monto: 300, valor_fecha: '2*/05' },
    ]);
    expect(out.vendedores[0].clientes).toEqual([{ nombre: 'LOPEZ RAUL', saldo: 300, n_filas: 1 }]);
  });

  it('ignora pestañas que no son de vendedor y matchea SEBASTIAN→SEBA', () => {
    const wb = wbCarpeta({
      CLIENTES: [['01/06/2026', 'NO DEBERIA APARECER', 1]],
      Hoja1: [['01/06/2026', 'TAMPOCO', 1]],
      SEBASTIAN: [['01/06/2026', 'CLIENTE SEBA', 100]],
    });
    const out = parseCarpeta(wb, CORTE);

    expect(out.pestanas_ignoradas.sort()).toEqual(['CLIENTES', 'Hoja1']);
    expect(out.vendedores).toHaveLength(1);
    expect(out.vendedores[0].cod_vendedor).toBe(2); // SEBA
  });
});

describe('cruzarVendedor — matching best-first', () => {
  it('el par exacto le gana al débil: DANTE no se casa con DONET', () => {
    const carpeta = [cc('DONET HERMANOS', 1000), cc('DANTE', 500)];
    const sistema = [cs(10, 'DONET HERMANOS', 1000)];
    const r = cruzarVendedor(carpeta, sistema, 20, false);

    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].carpeta).toBe('DONET HERMANOS');
    expect(r.matches[0].score).toBe(1);
    // DANTE queda sin match (no roba a DONET aunque el greedy ingenuo lo haría)
    expect(r.solo_carpeta.map(s => s.cliente)).toEqual(['DANTE']);
  });

  it('best-first global: el score alto se asigna primero aunque aparezca después', () => {
    // 'MANOLO' (carpeta) tiene containment alto contra 'MANOLO GOMEZ' (sistema),
    // pero el par exacto MANOLO GOMEZ↔MANOLO GOMEZ debe ganar ese lugar.
    const carpeta = [cc('MANOLO', 700), cc('MANOLO GOMEZ', 1000)];
    const sistema = [cs(1, 'MANOLO GOMEZ', 1000), cs(2, 'ARMANDO MANOLO', 700)];
    const r = cruzarVendedor(carpeta, sistema, 20, false);

    const porCarpeta = new Map(r.matches.map(m => [m.carpeta, m]));
    expect(porCarpeta.get('MANOLO GOMEZ')!.cod_cliente).toBe(1);
    expect(porCarpeta.get('MANOLO')!.cod_cliente).toBe(2);
  });

  it('tolerancia: dif de $1-2 cuenta como CUADRA con tolerancia 20', () => {
    const r = cruzarVendedor(
      [cc('PEREZ JUAN', 1000), cc('GOMEZ ANA', 5000)],
      [cs(1, 'PEREZ JUAN', 998), cs(2, 'GOMEZ ANA', 4000)],
      20,
      false,
    );
    const porCod = new Map(r.matches.map(m => [m.cod_cliente, m]));
    expect(porCod.get(1)!.estado).toBe('CUADRA');       // dif $2 ≤ 20
    expect(porCod.get(1)!.dif).toBe(2);
    expect(porCod.get(2)!.estado).toBe('DIFERENCIA');   // dif $1000
  });

  it('SUPER EMANUEL: saldo ~$0 en IM participa del matching → DIFERENCIA de $730k', () => {
    // Antes el filtro |saldo|<$1 lo sacaba del matching y salía como "solo
    // carpeta" en vez de la DIFERENCIA que el cruce debe gritar.
    const r = cruzarVendedor(
      [cc('SUPER EMANUEL', 730483)],
      [cs(77, 'SUPER EMANUEL', 1.94)],
      20,
      false,
    );
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].estado).toBe('DIFERENCIA');
    expect(r.matches[0].dif).toBeCloseTo(730481.06, 2);
    expect(r.solo_carpeta).toHaveLength(0);
  });

  it('residuos de centavos sin match NO se listan en solo_sistema (pero sí matchean)', () => {
    const r = cruzarVendedor(
      [],
      [cs(1, 'RESIDUO SRL', 0.66), cs(2, 'DEUDOR REAL', 5000)],
      20,
      false,
    );
    expect(r.solo_sistema.map(s => s.cod_cliente)).toEqual([2]); // el residuo queda afuera
  });

  it('marca ambiguo cuando el runner-up queda a <0.03 del elegido', () => {
    // 'GOMEZ' containment-matchea 0.95 contra ambos GOMEZ del sistema.
    const r = cruzarVendedor(
      [cc('GOMEZ', 1000)],
      [cs(1, 'GOMEZ CARLOS', 1000), cs(2, 'GOMEZ RAUL', 900)],
      20,
      false,
    );
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].ambiguo).toBe(true);
  });

  it('NO marca ambiguo un match claramente único', () => {
    const r = cruzarVendedor(
      [cc('PEREZ JUAN', 1000)],
      [cs(1, 'PEREZ JUAN', 1000), cs(2, 'TOTALMENTE OTRO', 900)],
      20,
      false,
    );
    expect(r.matches[0].ambiguo).toBeUndefined();
  });
});

describe('cruzarCarpeta — integrador', () => {
  const maestro: ClienteMaestro[] = [
    { cod_cliente: 100, razon_social: 'LOPEZ MARIA', cod_vendedor: 3 },     // MARCELO
    { cod_cliente: 900, razon_social: 'MONTERO LUIS', cod_vendedor: 12 },   // BRIAN
    { cod_cliente: 200, razon_social: 'RUIZ PEDRO', cod_vendedor: 6 },      // ANDREA
  ];
  const sistemaRows: PendienteIM[] = [
    { cod_cliente: 100, nombre: 'LOPEZ MARIA', saldo: 800, tipo_comprobante: 'FA', fecha_factura: '2026-06-10' },
    { cod_cliente: 900, nombre: 'MONTERO LUIS', saldo: 5000, tipo_comprobante: 'FA', fecha_factura: '2026-06-12' },
    { cod_cliente: 200, nombre: 'RUIZ PEDRO', saldo: 1500, tipo_comprobante: 'FA', fecha_factura: '2026-06-05' },
    { cod_cliente: 652, nombre: 'SUCURSAL SAN JUAN', saldo: 99999, tipo_comprobante: 'FA', fecha_factura: '2026-06-01' },
  ];
  const base = { maestro, corte: CORTE, tolerancia: 20, corteExacto: true, advertencia: null as string | null };

  it('cross-vendedor: MONTERO en carpeta de MARCELO existe (sin matchear) bajo BRIAN → anotado', () => {
    const carpeta = carpetaDe([
      { pestana: 'MARCELO', cod_vendedor: 3, clientes: [cc('LOPEZ MARIA', 800), cc('MONTERO LUIS', 5000)] },
    ]);
    const r = cruzarCarpeta({ ...base, carpeta, sistemaRows, recibos: [] });

    const marcelo = r.vendedores.find(v => v.pestana === 'MARCELO')!;
    expect(marcelo.matches.map(m => m.cod_cliente)).toEqual([100]); // LOPEZ matchea
    const montero = marcelo.solo_carpeta[0];
    expect(montero.cliente).toBe('MONTERO LUIS');
    expect(montero.cross_vendedor).toBeDefined();
    expect(montero.cross_vendedor!.cod_cliente).toBe(900);
    expect(montero.cross_vendedor!.vendedor).toBe('BRIAN');
    // BRIAN no subió hoja en esta carpeta → su cartera cae al grupo OTROS y
    // MONTERO queda listado ahí como solo-sistema → el hint lo dice.
    expect(montero.cross_vendedor!.en_solo_sistema).toBe(true);
  });

  it('cross-vendedor NO ofrece un cliente que YA matcheó en su propia pestaña', () => {
    // LOPEZ MARIA matchea en MARCELO; la carpeta de BRIAN también la anota
    // (duplicada). El cross NO debe sugerir el cod 100 ya conciliado.
    const carpeta = carpetaDe([
      { pestana: 'MARCELO', cod_vendedor: 3, clientes: [cc('LOPEZ MARIA', 800)] },
      { pestana: 'BRIAN', cod_vendedor: 12, clientes: [cc('LOPEZ MARIA', 800), cc('MONTERO LUIS', 5000)] },
    ]);
    const r = cruzarCarpeta({ ...base, carpeta, sistemaRows, recibos: [] });

    const brian = r.vendedores.find(v => v.pestana === 'BRIAN')!;
    // MONTERO matchea en BRIAN directamente (su pestaña existe acá)
    expect(brian.matches.map(m => m.cod_cliente)).toEqual([900]);
    const lopezDuplicada = brian.solo_carpeta.find(s => s.cliente === 'LOPEZ MARIA')!;
    expect(lopezDuplicada).toBeDefined();
    expect(lopezDuplicada.cross_vendedor).toBeUndefined(); // cod 100 ya matcheado en MARCELO
  });

  it('ANDREA: todos sus matches quedan tentativo:true', () => {
    const carpeta = carpetaDe([
      { pestana: 'ANDREA', cod_vendedor: 6, clientes: [cc('RUIZ PEDRO', 1500)] },
    ]);
    const r = cruzarCarpeta({ ...base, carpeta, sistemaRows, recibos: [] });

    const andrea = r.vendedores.find(v => v.pestana === 'ANDREA')!;
    expect(andrea.tentativo).toBe(true);
    expect(andrea.matches[0].tentativo).toBe(true);
  });

  it('transito_al_corte: anota pendientes al corte E imputados POST-corte (no los pre-corte)', () => {
    const recibos: ReciboTransito[] = [
      // pendiente con fecha ≤ corte → "aún en tránsito"
      { id: 'r1', cod_cliente: 100, monto: 300, fecha_comprobante: '2026-06-20', status: 'pendiente_revision' },
      // pendiente posterior al corte → NO
      { id: 'r2', cod_cliente: 100, monto: 999, fecha_comprobante: '2026-07-05', status: 'pendiente_revision' },
      // anticipo aprobado → NO es tránsito
      { id: 'a1', cod_cliente: 100, monto: 555, fecha_comprobante: '2026-06-15', status: 'aprobado' },
      // imputado DESPUÉS del corte con comprobante ≤ corte → estaba en tránsito AL corte (caso más común)
      { id: 'i1', cod_cliente: 100, monto: 200, fecha_comprobante: '2026-06-25', status: 'imputado', imputado_at: '2026-07-02T14:00:00Z' },
      // imputado ANTES del corte → ya estaba reflejado en IM al corte → NO
      { id: 'i2', cod_cliente: 100, monto: 111, fecha_comprobante: '2026-06-10', status: 'imputado', imputado_at: '2026-06-20T14:00:00Z' },
    ];
    const carpeta = carpetaDe([
      { pestana: 'MARCELO', cod_vendedor: 3, clientes: [cc('LOPEZ MARIA', 1300)] }, // dif 500 vs sistema 800
    ]);
    const r = cruzarCarpeta({ ...base, carpeta, sistemaRows, recibos });

    const m = r.vendedores.find(v => v.pestana === 'MARCELO')!.matches[0];
    expect(m.estado).toBe('DIFERENCIA');
    expect(m.transito_al_corte).toEqual([
      { monto: 300, fecha: '2026-06-20', status: 'pendiente_revision' },
      { monto: 200, fecha: '2026-06-25', status: 'imputado', imputado_at: '2026-07-02' },
    ]);
  });

  it('clientes de vendedor sin pestaña van al grupo OTROS y suman al total sistema', () => {
    const rowsConHuerfano: PendienteIM[] = [
      ...sistemaRows,
      { cod_cliente: 555, nombre: 'HUERFANO SA', saldo: 7000, tipo_comprobante: 'FA', fecha_factura: '2026-06-01' },
    ];
    const maestroConHuerfano: ClienteMaestro[] = [
      ...maestro,
      { cod_cliente: 555, razon_social: 'HUERFANO SA', cod_vendedor: 99 }, // vendedor sin pestaña
    ];
    const carpeta = carpetaDe([
      { pestana: 'MARCELO', cod_vendedor: 3, clientes: [cc('LOPEZ MARIA', 800)] },
    ]);
    const r = cruzarCarpeta({ ...base, carpeta, sistemaRows: rowsConHuerfano, maestro: maestroConHuerfano, recibos: [] });

    const otros = r.vendedores.find(v => v.pestana === PESTANA_OTROS)!;
    expect(otros).toBeDefined();
    expect(otros.solo_sistema.map(s => s.cod_cliente)).toContain(555);
    // Total sistema cuadra contra la cartera completa: MARCELO (800) +
    // OTROS: HUERFANO 7000 + MONTERO 5000 (BRIAN sin hoja) + RUIZ 1500 (ANDREA sin hoja)
    expect(r.totales.sistema).toBe(800 + 7000 + 5000 + 1500);
  });

  it('maestro del SNAPSHOT pisa al vivo: cliente reasignado post-corte cruza con su vendedor del corte', () => {
    // Al corte LOPEZ MARIA era de MARCELO; HOY el maestro vivo la tiene bajo BRIAN.
    const maestroVivoReasignado: ClienteMaestro[] = [
      { cod_cliente: 100, razon_social: 'LOPEZ MARIA', cod_vendedor: 12 }, // reasignada HOY
    ];
    const maestroSnapshot: MaestroSnapshot = {
      '100': { cod_vendedor: 3, nombre: 'LOPEZ MARIA' },                   // asignación AL corte
    };
    const carpeta = carpetaDe([
      { pestana: 'MARCELO', cod_vendedor: 3, clientes: [cc('LOPEZ MARIA', 800)] },
    ]);
    const rows: PendienteIM[] = [
      { cod_cliente: 100, nombre: 'LOPEZ MARIA', saldo: 800, tipo_comprobante: 'FA', fecha_factura: '2026-06-10' },
    ];
    const r = cruzarCarpeta({ ...base, carpeta, sistemaRows: rows, maestro: maestroVivoReasignado, maestroSnapshot, recibos: [] });

    const marcelo = r.vendedores.find(v => v.pestana === 'MARCELO')!;
    expect(marcelo.matches).toHaveLength(1); // matchea bajo MARCELO como al corte
    expect(marcelo.matches[0].estado).toBe('CUADRA');
    expect(marcelo.solo_carpeta).toHaveLength(0);
  });

  it('internas quedan fuera del cruce, con su saldo al corte', () => {
    const carpeta = carpetaDe([
      { pestana: 'MARCELO', cod_vendedor: 3, clientes: [cc('LOPEZ MARIA', 800)] },
    ]);
    const r = cruzarCarpeta({ ...base, carpeta, sistemaRows, recibos: [] });

    expect(r.internas).toEqual([{ cod_cliente: 652, nombre: 'SUCURSAL SAN JUAN', saldo: 99999 }]);
    for (const v of r.vendedores) {
      expect(v.solo_sistema.find(s => s.cod_cliente === 652)).toBeUndefined();
    }
  });
});

describe('resolverLadoSistema — snapshot vs foto viva', () => {
  const vivo: PendienteIM[] = [
    { cod_cliente: 1, saldo: 100, fecha_factura: '2026-06-15' },
    { cod_cliente: 2, saldo: 200, fecha_factura: '2026-07-05' },  // posterior al corte
    { cod_cliente: 3, saldo: 300 },                                // sin fecha → se conserva
  ];

  it('con snapshot NO vacío → corte_exacto true, sin advertencia, usa el snapshot tal cual', () => {
    const snap: PendienteIM[] = [{ cod_cliente: 9, saldo: 999, fecha_factura: '2026-06-01' }];
    const r = resolverLadoSistema(snap, vivo, CORTE);
    expect(r.corte_exacto).toBe(true);
    expect(r.advertencia).toBeNull();
    expect(r.rows).toBe(snap);
  });

  it('snapshot VACÍO se trata como inexistente → aproximado (no "exacto" con sistema vacío)', () => {
    const r = resolverLadoSistema([], vivo, CORTE);
    expect(r.corte_exacto).toBe(false);
    expect(r.advertencia).toMatch(/foto ACTUAL/i);
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it('sin snapshot → filtra fecha_factura > corte y AVISA cuántas filas sin fecha no pudo filtrar', () => {
    const r = resolverLadoSistema(null, vivo, CORTE);
    expect(r.corte_exacto).toBe(false);
    expect(r.rows.map(x => x.cod_cliente)).toEqual([1, 3]);
    expect(r.advertencia).toMatch(/1 comprobante sin fecha/);
  });
});
