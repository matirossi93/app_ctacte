import {expect,it,vi} from 'vitest';
import axios from 'axios';
vi.hoisted(()=>{process.env.INFOMANAGER_CLIENT_SECRET='test-secret';});
vi.mock('axios',()=>({default:{post:vi.fn(),create:vi.fn()}}));
import {leerComprobante,parsearCabeceraComprobante,parsearItemsComprobante} from './infomanager.js';
import {huellaPresupuesto} from './versionPresupuesto.js';
it('cabecera y renglones pertenecen al mismo GET y mantienen la huella de los parsers',async()=>{
 const data={results:{id:10,fecha:'2026-09-11',cod_cliente:7,cod_empresa:1,tipo_comprobante:'PR',anulada:'N',items:[{id:9,cod_articulo:3,cantidad:2,precio:100,iva_por:10.5}]}};
 const get=vi.fn(async()=>({data}));vi.mocked(axios.create).mockReturnValue({get,interceptors:{request:{use:vi.fn()}}} as any);vi.mocked(axios.post).mockResolvedValue({data:{token:'x'}});
 const completo=await leerComprobante('10');expect(get).toHaveBeenCalledTimes(1);expect(get).toHaveBeenCalledWith('/ventas/10');expect(completo.items).toHaveLength(1);
 expect(huellaPresupuesto('10',completo.cabecera,completo.items)).toBe(huellaPresupuesto('10',parsearCabeceraComprobante(data),parsearItemsComprobante(data)));
});
