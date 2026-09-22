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

/**
 * 🔄 22/09/2026 — EL GRANEL CUENTA BOLSAS, NO "UNA Y LISTA".
 *
 * Mati, sobre el pedido de CASTILLO (PR 58967): *"acá no está reconociendo que tiene 10 bultos
 * el cliente como para que al maíz quebrado le corresponda precio de lista 2"*. Llevaba 300 kg
 * de maíz molido + 30 de alubia + 25 de molido blanco + 1 bolsa cerrada, y la app contaba
 * **4 bultos**: la regla vieja daba 1 bulto por granel desde 20 kg y no escalaba, así que 300 kg
 * y 25 kg pesaban igual.
 *
 * 🔴 ESTO REVIERTE una definición anterior del propio Mati —"60 kg siguen siendo 1"— y se hizo
 * con el impacto medido a la vista: sobre 162 pedidos vivos, 5 (3%) pasan a alcanzar la promo
 * general. Si algún día el número se dispara, mirar acá primero.
 */
describe('los bultos de un granel salen de su bolsa', () => {
  const art = (cod: number, descripcion: string, um = 'Kilos') =>
    [cod, clasificarArticulo({ cod_articulo: cod, descripcion, subrubro: 'x', unidad_de_medida: um, equivalencia_um: 1 })] as const;
  const CAT = new Map([art(719, 'MAIZ MOLIDO AMARILLO'), art(723, 'POROTO ALUBIA'), art(613, 'PASAS CON SEMILLA')]);
  const FORMATOS = new Map([[719, 30], [723, 30]]);
  const r = (cod: number, cantidad: number) => ({ cod_articulo: cod, cantidad, cod_lista: 12 });

  it('🔑 300 kg con bolsa de 30 son 10 bultos, no 1', () => {
    expect(bultosDelPedido([r(719, 300)], CAT as any, FORMATOS)).toBe(10);
  });

  it('🔑 una bolsa justa es un bulto', () => {
    expect(bultosDelPedido([r(723, 30)], CAT as any, FORMATOS)).toBe(1);
  });

  it('🪤 sin kilaje cargado se usan 20 kg, que es la regla de siempre', () => {
    expect(bultosDelPedido([r(613, 100)], CAT as any, FORMATOS)).toBe(5);
    expect(bultosDelPedido([r(613, 25)], CAT as any, FORMATOS)).toBe(1);
  });

  it('🔴 lo que no llega a una bolsa sigue sin contar', () => {
    expect(bultosDelPedido([r(719, 29)], CAT as any, FORMATOS)).toBe(0);
    expect(bultosDelPedido([r(613, 5)], CAT as any, FORMATOS)).toBe(0);
  });

  it('🪤 sin el mapa de formatos se comporta como antes de este cambio', () => {
    // Las rutas que todavía no lo pasan no pueden cambiar de resultado sin que nadie lo note.
    expect(bultosDelPedido([r(719, 300)], CAT as any)).toBe(1);
  });

  it('🔑 el pedido de CASTILLO: 300 + 30 + 25 kg pasan de 3 bultos a 12', () => {
    const pedido = [r(719, 300), r(723, 30), r(613, 25)];
    expect(bultosDelPedido(pedido, CAT as any)).toBe(3);
    expect(bultosDelPedido(pedido, CAT as any, FORMATOS)).toBe(12);
  });
});
