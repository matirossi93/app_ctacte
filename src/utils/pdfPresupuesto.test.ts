import { describe, it, expect } from 'vitest';
import { generarPresupuestoPdf, type DatosPresupuesto } from './pdfPresupuesto';

/**
 * El papel que sale de la app.
 *
 * 🔄 Mati (09/09/2026): *"hay que hacerlo más chico, que entren más artículos por hoja"* y
 * *"tiene que decir la dirección y teléfono del cliente"*. Los dos se prueban contando las
 * páginas del PDF de verdad, no estimando: es lo único que dice si la compactación alcanzó.
 */

/** Cuántas páginas tiene el PDF generado. jsPDF no comprime, así que se cuentan del stream. */
async function paginas(d: DatosPresupuesto): Promise<number> {
  const { blob } = generarPresupuestoPdf(d);
  const txt = await blob.text();
  return (txt.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

const items = (n: number) => Array.from({ length: n }, (_, i) => ({
  descripcion: `ALIMENTO BALANCEADO PARA PERRO ADULTO X 20 KG ${i + 1}`,
  cod_articulo: 100 + i, cantidad: 3, precio_unit: 18733.03,
  descuento_porc: null, subtotal: 56199.09,
}));

const base: DatosPresupuesto = {
  numero: 58300, cliente: 'DIAZ, Alfredo (Este)',
  domicilio: 'CRUZ ALTA · Cruz Alta', telefono: '3815628685',
  fecha: '2026-09-09', items: items(10),
};

describe('cuántos renglones entran por hoja', () => {
  /**
   * 🔴 El caso real que lo motivó: el presupuesto de DIAZ, Alfredo tiene 42 renglones. Con el
   * formato viejo (banda de 30 mm, fila de 8,4) entraban ~24 por hoja y ese pedido ocupaba DOS.
   * Medido con el formato nuevo: entran 45.
   */
  it('🔑 42 renglones entran en UNA sola hoja', async () => {
    expect(await paginas({ ...base, items: items(42) })).toBe(1);
  });

  it('un pedido chico obviamente también', async () => {
    expect(await paginas({ ...base, items: items(8) })).toBe(1);
  });

  /** Con muchos más sí pasa a dos, y eso está bien: lo que no puede es partir de a 24. */
  it('recién a partir de 46 pasa a dos hojas', async () => {
    expect(await paginas({ ...base, items: items(45) })).toBe(1);
    expect(await paginas({ ...base, items: items(46) })).toBe(2);
  });

  it('el total nunca queda partido: si no entra, se va a la hoja siguiente', async () => {
    // Un pedido que termina justo en el borde no puede dejar la caja del total a medias.
    for (const n of [44, 45, 46, 47]) {
      expect(await paginas({ ...base, items: items(n) })).toBeLessThanOrEqual(2);
    }
  });
});

describe('los datos del cliente van en el papel', () => {
  it('🔑 el domicilio y el teléfono salen impresos', async () => {
    const { blob } = generarPresupuestoPdf(base);
    const txt = await blob.text();
    expect(txt).toContain('CRUZ ALTA');
    expect(txt).toContain('3815628685');
  });

  it('sin domicilio ni teléfono no rompe ni deja el rótulo colgado', async () => {
    const { blob } = generarPresupuestoPdf({ ...base, domicilio: null, telefono: null });
    expect((await blob.text()).length).toBeGreaterThan(1000);
  });
});

describe('el mismo formato sirve para los tres comprobantes', () => {
  it('🪤 una FACTURA no lleva la leyenda de presupuesto', async () => {
    const conLeyenda = await (await generarPresupuestoPdf(base).blob).text();
    expect(conLeyenda).toContain('sujeto a confirm');
    const factura = await (await generarPresupuestoPdf({ ...base, tipo: 'Factura' }).blob).text();
    expect(factura).not.toContain('sujeto a confirm');
  });

  it('el nombre del archivo dice qué comprobante es', () => {
    expect(generarPresupuestoPdf({ ...base, tipo: 'Remito' }).nombre).toMatch(/^Remito-58300/);
    expect(generarPresupuestoPdf(base).nombre).toMatch(/^Presupuesto-58300/);
  });
});
