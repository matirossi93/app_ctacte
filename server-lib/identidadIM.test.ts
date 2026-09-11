import { expect,it } from 'vitest';
import { idIM,ivaExplicita } from './identidadIM.js';
import { interpretarActualizacionIM } from './respuestaActualizacionIM.js';
it.each([0,-1,{},'ERROR',true,1.5,Number.MAX_SAFE_INTEGER+1,'','-1','1e2',null])('rechaza ID inválido %j',v=>{
 expect(idIM(v)).toBeNull();if(v!=null) expect(interpretarActualizacionIM({id:v}).ok).toBe(false);
});
it('IDs decimales válidos y IVA cero explícito',()=>{
 expect(idIM('00123')).toBe('123');expect(idIM(123)).toBe('123');expect(ivaExplicita(0)).toBe(0);
 for(const v of [undefined,null,'',true,{},'nan'])expect(ivaExplicita(v)).toBeNull();
});
