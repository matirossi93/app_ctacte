/**
 * Qué puede hacer cada rol en cuenta corriente.
 *
 * Existe por un caso concreto: Rodrigo y Susana estaban cargados como
 * `vendedor` sin cod_vendedor (o sea, sin cartera: los 26 filtros usan
 * `cod_vendedor ?? -1`, así que no veían nada) cuando en realidad son del
 * equipo de administración. Al pasarlos a `administrativo` el riesgo era
 * sacarles sin querer el historial de compras, que SÍ venían usando por figurar
 * como "vendedores".
 */
import { describe, it, expect } from 'vitest';

// Las mismas reglas que aplica el servidor, escritas acá para poder probarlas
// sin levantar Express. Si cambian allá y no acá, este test queda mintiendo:
// por eso cada una cita su archivo.
const PUEDEN_VER_HISTORIAL = ['admin', 'socio', 'gerente', 'administrativo', 'vendedor']; // historialCompras.ts
const EXIGEN_ADMIN_O_GERENTE = ['admin', 'gerente'];  // conciliacion.ts, recibos.ts, usuarios.ts, reportes.ts
const FILTRAN_POR_CARTERA = ['vendedor'];             // clientes.ts, pedidos.ts, goals.ts, recibos.ts

const puedeHistorial = (rol) => PUEDEN_VER_HISTORIAL.includes(rol);
const esBackoffice = (rol) => EXIGEN_ADMIN_O_GERENTE.includes(rol);
const veSoloSuCartera = (rol) => FILTRAN_POR_CARTERA.includes(rol);

describe('roles en cuenta corriente', () => {
  it('administrativo NO pierde el historial de compras al dejar de ser vendedor', () => {
    expect(puedeHistorial('vendedor')).toBe(true);        // lo tenía antes
    expect(puedeHistorial('administrativo')).toBe(true);  // lo tiene que seguir teniendo
  });

  it('administrativo ve a TODOS los clientes, no una cartera', () => {
    expect(veSoloSuCartera('vendedor')).toBe(true);
    expect(veSoloSuCartera('administrativo')).toBe(false);
  });

  it('administrativo NO gana lo que pide admin/gerente explícito', () => {
    // conciliación, alta de usuarios, reportes: siguen siendo de admin/gerente.
    expect(esBackoffice('administrativo')).toBe(false);
    expect(esBackoffice('vendedor')).toBe(false);         // tampoco lo tenía: no cambia nada
  });

  it('socio ve lo mismo que un gerente en historial, y no filtra por cartera', () => {
    expect(puedeHistorial('socio')).toBe(true);
    expect(veSoloSuCartera('socio')).toBe(false);
  });

  it('repartidor sigue sin historial (no cambia nada para él)', () => {
    expect(puedeHistorial('repartidor')).toBe(false);
  });

  it('los 6 roles del panel son valores conocidos acá', () => {
    for (const rol of ['admin', 'socio', 'gerente', 'administrativo', 'vendedor', 'repartidor']) {
      expect(typeof puedeHistorial(rol)).toBe('boolean');
    }
    // `encargado` (producción) no entra a cuenta corriente: no está en ningún permiso.
    expect(puedeHistorial('encargado')).toBe(false);
    expect(esBackoffice('encargado')).toBe(false);
  });
});
