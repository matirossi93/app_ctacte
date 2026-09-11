import { describe, it, expect } from 'vitest';
import { clasificarArticulo, bultosDelPedido, evaluarPedido, type ReglaLista } from './listas.js';

// Casos del catálogo real; cantidades sintéticas, ninguna consulta a InfoManager.
const crudos = [
  {cod_articulo:400,descripcion:'ALPISTE',subrubro:'Cereales',unidad_de_medida:'Kilos'},
  {cod_articulo:402,descripcion:'MIJO',subrubro:'Cereales',unidad_de_medida:'Kilos'},
  {cod_articulo:491,descripcion:'MEZCLA GALLO PREMIUM',subrubro:'Mezclas',equivalencia_um:1},
  {cod_articulo:528,descripcion:'CACAO AMARGO',subrubro:'Condimentos',equivalencia_um:1},
  {cod_articulo:617,descripcion:'NUEZ PELADA LIGHT',subrubro:'Frutos secos',equivalencia_um:0},
  {cod_articulo:618,descripcion:'ALMENDRAS P/ MIX',subrubro:'Frutos Secos',equivalencia_um:1},
  {cod_articulo:731,descripcion:'ANIS ESTRELLADO',subrubro:'Condimentos',equivalencia_um:0},
  {cod_articulo:514,descripcion:'NUEZ MOSCADA',subrubro:'Condimentos',unidad_de_medida:'unidades',equivalencia_um:1},
  {cod_articulo:10515,descripcion:'VAINILLIN CHICO',subrubro:'Condimentos',equivalencia_um:1},
  {cod_articulo:10510,descripcion:'JENGIBRE EN RAMA X GR',subrubro:'Condimentos',equivalencia_um:1},
  {cod_articulo:921,descripcion:'COLLAR ANTIPULGAS CHICO',subrubro:'Accesorios Perros y Gatos'},
  {cod_articulo:962,descripcion:'PIPETA CHICA',subrubro:'Accesorios Perros y Gatos'},
  {cod_articulo:987,descripcion:'SHAMPOO OSSPRET 2 EN 1 X 250 CC',subrubro:'Accesorios Perros y Gatos'},
  {cod_articulo:1987,descripcion:'SHAMPOO ELMER CACHORRO X 250 CC',subrubro:'Accesorios Aves',unidad_de_medida:'Bolsas',equivalencia_um:1},
  {cod_articulo:1,descripcion:'BEBE X 25 KG - GANAVE',subrubro:'Ganave',unidad_de_medida:'Bolsas',equivalencia_um:25},
  {cod_articulo:671,descripcion:'FRAC. PANCETA MANI CHEFF MK 15X80 GR',subrubro:'Fraccionado',unidad_de_medida:'Fardo'},
  {cod_articulo:10471,descripcion:'CHALAS X UNIDAD',subrubro:'Legumbres'},
  {cod_articulo:10244,descripcion:'FULLCAT X KG',subrubro:'Flecky'},
  {cod_articulo:13818,descripcion:'FORRAJES VARIOS',subrubro:'Varios'},
  {cod_articulo:13819,descripcion:'DISTRIBUCION',subrubro:'Varios'},
];
const cat = new Map(crudos.map(a => [a.cod_articulo,clasificarArticulo(a)]));
const renglon = (cod_articulo:number,cantidad:number) => ({cod_articulo,cantidad,cod_lista:13});
const reglas: ReglaLista[] = [
  {nombre:'Ganave',match_tipo:'subrubro',match_valor:'Ganave',cod_lista:12,condicion:'libre',umbral:null,unidad:null,ambito:null},
  {nombre:'Ganave',match_tipo:'subrubro',match_valor:'Ganave',cod_lista:13,condicion:'promo_general',umbral:10,unidad:'bulto',ambito:'pedido'},
];

describe('bultos comerciales confirmados el 11/09',()=>{
  it.each([[19.99,0],[20,1],[60,1],[1000,1]])('%s kg del mismo granel cuentan %s bulto', (kg,bultos)=>{
    expect(bultosDelPedido([renglon(400,kg)],cat)).toBe(bultos);
  });
  it('suma renglones del mismo granel sin sumar kilos de artículos diferentes',()=>{
    expect(bultosDelPedido([renglon(400,10),renglon(400,10)],cat)).toBe(1);
    expect(bultosDelPedido([renglon(400,10),renglon(402,10)],cat)).toBe(0);
    expect(bultosDelPedido([renglon(400,60),renglon(402,20)],cat)).toBe(2);
  });
  it.each([921,962,987,1987,514,10515,10510,10471,13818,13819,99999])('100 unidades del código %s no agregan bultos',cod=>{
    const resultado=evaluarPedido([renglon(1,9),renglon(cod,100)],cat,reglas);
    expect(resultado.bultos).toBe(9); expect(resultado.promo_general).toBe(false);
    expect(resultado.avisos[0].lista_sugerida).toBe(12);
  });
  it('nueve bolsas y 20 kg habilitan la promo; 19 kg no',()=>{
    expect(evaluarPedido([renglon(1,9),renglon(400,20)],cat,reglas).promo_general).toBe(true);
    expect(evaluarPedido([renglon(1,9),renglon(400,19)],cat,reglas).promo_general).toBe(false);
  });
  it('conserva graneles con UM ausente y los espejos vendidos por kilo',()=>{
    expect(bultosDelPedido([renglon(491,20),renglon(10244,20)],cat)).toBe(2);
  });
  it.each([528,617,618,731])('el granel real %s conserva sus kilos aunque no tenga UM',cod=>{
    expect(bultosDelPedido([renglon(cod,20)],cat)).toBe(1);
    const porKilo:ReglaLista[]=[{...reglas[0],match_tipo:'articulo',match_valor:String(cod)},
      {...reglas[1],match_tipo:'articulo',match_valor:String(cod),cod_lista:14,condicion:'min',umbral:10,unidad:'kg',ambito:'articulo'}];
    expect(evaluarPedido([{...renglon(cod,20),cod_lista:14}],cat,porKilo).avisos[0].severidad).toBe('ok');
  });
  it('las bolsas y fardos cerrados siguen contando por unidad vendida',()=>{
    expect(bultosDelPedido([renglon(1,2),renglon(671,3)],cat)).toBe(5);
  });
  it('los productos pequeños conservan sus reglas en unidades sin inventar kilos',()=>{
    const porUnidad: ReglaLista[]=[
      {...reglas[0],match_valor:'Accesorios Perros y Gatos'},
      {...reglas[1],match_valor:'Accesorios Perros y Gatos',condicion:'min',umbral:20,unidad:'unidad',ambito:'articulo'},
    ];
    expect(evaluarPedido([renglon(921,20)],cat,porUnidad).avisos[0].lista_sugerida).toBe(13);
    expect(evaluarPedido([renglon(921,20)],cat,[porUnidad[0],{...porUnidad[1],unidad:'kg'}]).avisos[0].lista_sugerida).toBe(12);
  });
});
