import { describe, expect, it } from 'vitest';
import { parsearPendientesCliente } from './respuestaPendientesCliente.js';
describe('el cuerpo de pendientes confirma datos, no sólo HTTP200', () => {
  it.each([{error:99,mensaje:'No se pudo consultar saldo'}, {error:99,results:[]}, {success:false,results:[]}, {}, null, {results:{}}, {mensaje:'sin respuesta'}])('rechaza error o envoltorio ilegible: %j', body => {
    expect(() => parsearPendientesCliente(body)).toThrow();
  });
  it.each([[], {results:[]}, {comprobantes:[]}])('acepta cero explícito: %j', body => {
    expect(parsearPendientesCliente(body)).toEqual([]);
  });
  it.each([{}, {id:'1'}, {id:'1',saldo:null}, {id:'1',saldo:''}, {id:'1',saldo:false}, {id:'1',saldo:'ilegible'}, {id:'1',saldo:Infinity}, {id:null,saldo:10}])('no convierte una fila inválida en deuda cero: %j', fila => {
    expect(() => parsearPendientesCliente({results:[fila]})).toThrow();
  });
  it('conserva NC y saldo cero legítimos; no duplica identidad', () => {
    expect(parsearPendientesCliente({results:[{id:1,saldo:'-10.25'},{id:2,saldo:0}]}).map(f => f.saldo)).toEqual([-10.25,0]);
    expect(() => parsearPendientesCliente({results:[{id:1,saldo:10},{id:'1',saldo:10}]})).toThrow();
  });
});
