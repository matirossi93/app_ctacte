import { describe, it, expect } from 'vitest';
import { usuariosPorCod } from './usuariosPorCod.js';

// Filas reales del incidente del 10/08/2026: un script de diagnóstico del 31/07
// dejó dos usuarios sueltos y el Ranking del panel empezó a mostrar
// "DIAG vendedor" en lugar de "Brian" (los dos con cod_vendedor 12).
const BRIAN = {
  id: 'bff0dd62-0000-0000-0000-000000000001',
  email: 'brian@semillero',
  cod_vendedor: 12,
  nombre: 'Brian',
  activo: true,
  created_at: '2026-04-20T13:14:31.218720+00:00',
};
const DIAG = {
  id: '19b6fe70-0000-0000-0000-000000000002',
  email: 'diag.vendedor@semillero.test',
  cod_vendedor: 12,
  nombre: 'DIAG vendedor',
  activo: true,
  created_at: '2026-07-31T13:47:00.000000+00:00',
};
const MARCELO = {
  id: '23badc7a-0000-0000-0000-000000000003',
  email: 'marcelo@semillero',
  cod_vendedor: 3,
  nombre: 'Marcelo',
  activo: true,
  created_at: '2026-04-20T13:14:31.218720+00:00',
};

describe('usuariosPorCod', () => {
  it('con cod duplicado gana el más viejo (caso Brian vs DIAG vendedor del 10/08)', () => {
    const { byCod } = usuariosPorCod([BRIAN, DIAG]);
    expect(byCod.get(12)?.nombre).toBe('Brian');
  });

  it('el resultado NO depende del orden en que vengan las filas', () => {
    // El bug original: PostgREST sin ORDER BY devuelve el orden físico del heap,
    // y cualquier UPDATE sobre una fila la manda al final. Con last-write-wins
    // eso alcanzaba para cambiar qué nombre se mostraba.
    expect(usuariosPorCod([BRIAN, DIAG]).byCod.get(12)?.nombre).toBe('Brian');
    expect(usuariosPorCod([DIAG, BRIAN]).byCod.get(12)?.nombre).toBe('Brian');
  });

  it('un duplicado ACTIVO no puede ser pisado por uno inactivo, aunque sea más viejo', () => {
    const viejoDeBaja = { ...DIAG, activo: false, created_at: '2020-01-01T00:00:00+00:00' };
    const { byCod } = usuariosPorCod([viejoDeBaja, BRIAN]);
    expect(byCod.get(12)?.nombre).toBe('Brian');
  });

  it('si el único usuario del cod está inactivo, igual lo devuelve (no lo esconde)', () => {
    // goals.ts decide aparte si mostrarlo o no; acá no se filtra, sólo se elige.
    const soloInactivo = { ...BRIAN, activo: false };
    const { byCod } = usuariosPorCod([soloInactivo]);
    expect(byCod.get(12)?.nombre).toBe('Brian');
    expect(byCod.get(12)?.activo).toBe(false);
  });

  it('activo null/undefined cuenta como activo (misma semántica que goals.ts)', () => {
    const sinFlag = { ...BRIAN, activo: null };
    const inactivoExplicito = { ...DIAG, activo: false };
    const { byCod } = usuariosPorCod([inactivoExplicito, sinFlag]);
    expect(byCod.get(12)?.nombre).toBe('Brian');
  });

  it('reporta los cods duplicados para poder loguearlos', () => {
    const { dupCods } = usuariosPorCod([BRIAN, DIAG, MARCELO]);
    expect(dupCods).toEqual([12]);
  });

  it('sin duplicados dupCods viene vacío', () => {
    expect(usuariosPorCod([BRIAN, MARCELO]).dupCods).toEqual([]);
  });

  it('descarta cod_vendedor null/undefined/vacío (Number(null) es 0, no un cod)', () => {
    const admin = { ...BRIAN, id: 'x', cod_vendedor: null, nombre: 'Matías Rossi' };
    const sinCampo = { id: 'y', nombre: 'Manolo' };
    const vacio = { id: 'z', cod_vendedor: '', nombre: 'Fantasma' };
    const { byCod } = usuariosPorCod([admin, sinCampo, vacio, BRIAN] as any);
    expect(byCod.has(0)).toBe(false);
    expect([...byCod.keys()]).toEqual([12]);
  });

  it('normaliza cod_vendedor string a number (PostgREST puede devolver texto)', () => {
    const { byCod } = usuariosPorCod([{ ...BRIAN, cod_vendedor: '12' as unknown as number }]);
    expect(byCod.get(12)?.nombre).toBe('Brian');
  });

  it('empate perfecto de created_at → desempata por id, determinista en los dos órdenes', () => {
    const a = { ...BRIAN, id: 'aaa', nombre: 'A' };
    const b = { ...BRIAN, id: 'bbb', nombre: 'B' };
    expect(usuariosPorCod([a, b]).byCod.get(12)?.nombre).toBe('A');
    expect(usuariosPorCod([b, a]).byCod.get(12)?.nombre).toBe('A');
  });

  it('created_at ausente o corrupto pierde contra uno con fecha válida', () => {
    const sinFecha = { ...DIAG, created_at: null };
    const corrupto = { ...DIAG, id: 'ccc', created_at: 'no-es-fecha' };
    expect(usuariosPorCod([sinFecha, BRIAN]).byCod.get(12)?.nombre).toBe('Brian');
    expect(usuariosPorCod([corrupto, BRIAN]).byCod.get(12)?.nombre).toBe('Brian');
  });

  it('tolera null/undefined de entrada sin explotar', () => {
    expect(usuariosPorCod(null).byCod.size).toBe(0);
    expect(usuariosPorCod(undefined).byCod.size).toBe(0);
    expect(usuariosPorCod([]).byCod.size).toBe(0);
  });

  it('preserva la fila entera, no sólo el nombre (los call sites usan email/id/activo)', () => {
    const { byCod } = usuariosPorCod([DIAG, BRIAN]);
    expect(byCod.get(12)).toEqual(BRIAN);
  });
});
