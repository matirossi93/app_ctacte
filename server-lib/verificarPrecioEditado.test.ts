import { beforeEach, expect, it, vi } from 'vitest';
const precio = vi.hoisted(() => vi.fn());
vi.mock('./infomanager.js', () => ({ getPrecioLista: precio }));
import { verificarPreciosEditados } from './verificarPrecioEditado.js';
const viejo = [{ cod_articulo: 1, cod_lista_precios: 12, precio_orig: 100 }];
beforeEach(() => precio.mockReset().mockResolvedValue({ precio_vta: 70 }));

it('no admite etiqueta L4 con el precio anterior de L1', async () => {
  await expect(verificarPreciosEditados([{ cod_articulo: 1, cod_lista_precios: 15, precio: 100 }], viejo, 13819)).rejects.toThrow('no corresponde');
});
it('acepta la cotización de la nueva lista', async () => {
  await verificarPreciosEditados([{ cod_articulo: 1, cod_lista_precios: 15, precio: 70 }], viejo, 13819);
  expect(precio).toHaveBeenCalledWith(1, 15);
});
it('no cambia ni consulta precios históricos al editar cantidades o descuentos', async () => {
  await verificarPreciosEditados([{ cod_articulo: 1, cod_lista_precios: 12, precio: 100 }], viejo, 13819);
  expect(precio).not.toHaveBeenCalled();
});
it('un renglón adicional del mismo artículo se cotiza aunque ya exista otro', async () => {
  await expect(verificarPreciosEditados([{ cod_articulo: 1, cod_lista_precios: 12, precio: 100 }, { cod_articulo: 1, cod_lista_precios: 12, precio: 100 }], viejo, 13819)).rejects.toThrow('no corresponde');
});
it('sin cotización se frena, y distribución conserva el importe manual', async () => {
  precio.mockResolvedValue(null);
  await expect(verificarPreciosEditados([{ cod_articulo: 2, cod_lista_precios: 12, precio: 100 }], viejo, 13819)).rejects.toThrow('no tiene precio');
  await verificarPreciosEditados([{ cod_articulo: 13819, cod_lista_precios: 12, precio: 1234 }], [], 13819);
});

it('cotiza una fila cambiada sin consumir el precio histórico de otra fila del mismo artículo', async () => {
  precio.mockResolvedValue({ precio_vta: 80 });
  await verificarPreciosEditados([{ cod_articulo: 1, cod_lista_precios: 13, precio: 80 }, { cod_articulo: 1, cod_lista_precios: 13, precio: 90 }], [...viejo, { cod_articulo: 1, cod_lista_precios: 13, precio_orig: 90 }], 13819);
  expect(precio).toHaveBeenCalledTimes(1);
});
it('intercambiar etiquetas de dos filas no autoriza intercambiar sus precios históricos', async () => {
  await expect(verificarPreciosEditados([{ cod_articulo: 1, cod_lista_precios: 13, precio: 100 }, { cod_articulo: 1, cod_lista_precios: 12, precio: 90 }], [...viejo, { cod_articulo: 1, cod_lista_precios: 13, precio_orig: 90 }], 13819)).rejects.toThrow('no corresponde');
});
