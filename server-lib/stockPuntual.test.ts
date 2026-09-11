import {beforeEach,expect,it,vi} from 'vitest';
import axios from 'axios';
vi.hoisted(()=>{process.env.INFOMANAGER_CLIENT_SECRET='test-secret';});
vi.mock('axios',()=>({default:{create:vi.fn(),post:vi.fn()}}));
import {fetchStockPorDeposito,stockPuntualDelDeposito,invalidarIM} from './infomanager.js';
const get=vi.fn();
beforeEach(()=>{
 vi.clearAllMocks();invalidarIM();
 vi.mocked(axios.create).mockReturnValue({get,interceptors:{request:{use:vi.fn()}}} as any);
 get.mockImplementation(async ruta=>({data:ruta.includes('stock_por_deposito')?{stocks:[{cod_articulo:59,stock:-24}]}:
   {Existencias:[{codDeposito:1,stock:'0.00'},{codDeposito:2,stock:'35.00'}],Total:'35.00'}}));
});
it('completa TERMINADOR60 con cero explícito y comparte consultas para Pérez y Córdoba',async()=>{
 const [p,c]=await Promise.all([fetchStockPorDeposito(1,false,[59,60]),fetchStockPorDeposito(1,false,[60,60])]);
 expect(p.get(60)).toBe(0);expect(c.get(60)).toBe(0);expect(p.get(59)).toBe(-24);
 expect(get.mock.calls.filter(([url])=>url==='/articulos/stock_existencias/60')).toHaveLength(1);
 expect(get.mock.calls.filter(([url])=>url.includes('stock_por_deposito'))).toHaveLength(1);
 await fetchStockPorDeposito(1,false,[60]);expect(get).toHaveBeenCalledTimes(2);
});
it('no inventa cero si la consulta no identifica el depósito o falla',async()=>{
 get.mockImplementation(async ruta=>{
   if(ruta.includes('stock_por_deposito'))return {data:{stocks:[]}};
   throw {response:{status:400},message:'No existe'};
 });
 expect((await fetchStockPorDeposito(1,false,[60])).has(60)).toBe(false);
});
it.each([{}, {Total:0}, {Existencias:[{codDeposito:2,stock:0}]},
 {Existencias:[{codDeposito:1,stock:null}]}, {Existencias:[{codDeposito:1,stock:''}]},
 {Existencias:[{codDeposito:1,stock:'?'}]}, {Existencias:[{codDeposito:1,stock:0},{codDeposito:1,stock:2}]}])('no usa ausencia, total general ni datos ambiguos como stock %j',data=>{
 expect(stockPuntualDelDeposito(data,1)).toBeNull();
});
it('Actualizar invalida también el stock puntual',async()=>{
 await fetchStockPorDeposito(1,false,[60]);
 get.mockImplementation(async ruta=>({data:ruta.includes('stock_por_deposito')?{stocks:[]}:{Existencias:[{codDeposito:1,stock:'5.00'}]}}));
 expect((await fetchStockPorDeposito(1,true,[60])).get(60)).toBe(5);
});
