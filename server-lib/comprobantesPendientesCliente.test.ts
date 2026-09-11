import {beforeEach,expect,it,vi} from 'vitest';
import axios from 'axios';
vi.hoisted(()=>{process.env.INFOMANAGER_CLIENT_SECRET='test-secret';});
vi.mock('axios',()=>({default:{post:vi.fn(),create:vi.fn()}}));
import {comprobantesPendientesCliente,invalidarIM} from './infomanager.js';
const get=vi.fn();
beforeEach(()=>{vi.clearAllMocks();invalidarIM();vi.mocked(axios.create).mockReturnValue({get,interceptors:{request:{use:vi.fn()}}} as any);vi.mocked(axios.post).mockResolvedValue({data:{token:'x'}});});
it('GET200 error de IM rechaza sin convertirlo en lista vacía ni repetir GET',async()=>{get.mockResolvedValue({data:{error:99,mensaje:'No se pudo consultar saldo'}});await expect(comprobantesPendientesCliente(7,1)).rejects.toThrow('no confirmó');expect(get).toHaveBeenCalledTimes(1);});
it('GET200 lista vacía explícita sí acredita cero; importes malformados no',async()=>{get.mockResolvedValueOnce({data:{results:[]}}).mockResolvedValueOnce({data:{results:[{id:99,saldo:null}]}});expect(await comprobantesPendientesCliente(7,1)).toEqual([]);await expect(comprobantesPendientesCliente(7,1)).rejects.toThrow('importe verificable');});
