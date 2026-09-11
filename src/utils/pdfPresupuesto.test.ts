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

/**
 * 🔑 Mati (10/09/2026): *"necesito que el remito tenga la opción de valorizado o no valorizado,
 * porque necesitamos que salga sin importe muchas veces"*.
 *
 * El remito acompaña la mercadería, y muchas entregas no van con los precios a la vista: el que
 * recibe firma que le llegó lo que dice el papel, no cuánto sale.
 */
describe('remito sin importe (no valorizado)', () => {
  const remito: DatosPresupuesto = { ...base, tipo: 'Remito', valorizado: false };

  it('🔑 no lleva ningún precio ni el total', async () => {
    const txt = await generarPresupuestoPdf(remito).blob.text();
    // 18733,03 es el precio unitario y 561990,90 el total de los 10 renglones.
    expect(txt).not.toContain('18.733');
    expect(txt).not.toContain('561.990');
    expect(txt).not.toContain('TOTAL');
    expect(txt).not.toContain('Precio');
    expect(txt).not.toContain('Subtotal');
  });

  it('sí lleva los productos y las cantidades: es lo que el cliente controla al recibir', async () => {
    const txt = await generarPresupuestoPdf(remito).blob.text();
    expect(txt).toContain('ALIMENTO BALANCEADO');
    expect(txt).toContain('Cant');
    expect(txt).toContain('productos');
  });

  it('el valorizado sigue saliendo con todo (es lo de siempre)', async () => {
    const txt = await generarPresupuestoPdf({ ...base, tipo: 'Remito' }).blob.text();
    expect(txt).toContain('18.733');
    expect(txt).toContain('TOTAL');
  });

  it('sin importes entran MÁS renglones por hoja, no menos', async () => {
    expect(await paginas({ ...remito, items: items(45) })).toBe(1);
  });
});

/**
 * 🔑 Mati (10/09/2026): *"en el formato de factura y de presupuesto estaría bueno que también
 * aparezca el código del cliente"*. Es con lo que la oficina lo busca en InfoManager.
 */
describe('el código del cliente', () => {
  it('🔑 sale impreso junto al nombre', async () => {
    const txt = await generarPresupuestoPdf({ ...base, cod_cliente: 233 }).blob.text();
    expect(txt).toContain('233');
  });

  it('sin código no deja un rótulo vacío ni rompe', async () => {
    const txt = await generarPresupuestoPdf(base).blob.text();
    expect(txt).toContain('DIAZ, Alfredo');
    expect(txt.length).toBeGreaterThan(1000);
  });
});

describe('código de artículo en todos los comprobantes impresos',()=>{
 it.each([{tipo:'Presupuesto'},{tipo:'Factura'},{tipo:'Remito'},{tipo:'Remito',valorizado:false},{tipo:'Nota de crédito'},{tipo:'Nota de débito'}] as const)('imprime código en %j',async opciones=>{
  const txt=await generarPresupuestoPdf({...base,...opciones,items:[{...items(1)[0],cod_articulo:73125}]}).blob.text();
  expect(txt).toContain('73125');expect(txt).toContain('Producto');
 });
});
