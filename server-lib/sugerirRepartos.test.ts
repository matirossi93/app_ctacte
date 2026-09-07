import { describe, it, expect } from 'vitest';
import { sugerirRepartos, type PedidoAReparto, type CamionDisponible } from './sugerirRepartos.js';

/**
 * Partir el día en hojas que entren en los camiones. Es el trabajo manual que más tiempo le
 * lleva a Jorgelina, y las reglas salen del circuito real (Mati, 07/09/2026).
 */

/** La flota real: 1×5.000, 2×7.000 y 1×12.000 kg. */
const FLOTA: CamionDisponible[] = [
  { id: 'c5', nombre: 'Camión 5.000', capacidad_kg: 5000 },
  { id: 'c7a', nombre: 'Camión 7.000 A', capacidad_kg: 7000 },
  { id: 'c7b', nombre: 'Camión 7.000 B', capacidad_kg: 7000 },
  { id: 'c12', nombre: 'Camión 12.000', capacidad_kg: 12000 },
];

let n = 0;
const ped = (kg: number, cod_zona: number | null = 9, cliente = ''): PedidoAReparto => ({
  im_comprobante_id: `c${++n}`, cod_cliente: n, cliente_nombre: cliente || `Cliente ${n}`,
  cod_zona, zona: cod_zona ? `Zona ${cod_zona}` : 'Sin zona', kg,
});

describe('sugerirRepartos', () => {
  it('🔴 UNA ZONA QUE NO ENTRA EN UN CAMIÓN se parte en varios repartos', () => {
    // El caso real: la zona 10 daba 22.517 kg el 04/09 contra un camión máximo de 12.000.
    const s = sugerirRepartos([ped(8000, 10), ped(6000, 10), ped(6000, 10)], FLOTA);
    expect(s.repartos.length).toBe(3);
    expect(s.sin_camion).toHaveLength(0);
    for (const r of s.repartos) expect(r.kg).toBeLessThanOrEqual(r.camion!.capacidad_kg);
  });

  it('🔴 dos pedidos de 8.000 kg = DOS VIAJES del mismo camión, no "no entra"', () => {
    // 🪤 Sólo el de 12.000 aguanta 8.000 kg, así que hacen falta dos viajes. La primera
    // versión de esto marcaba el segundo como `sin_camion` porque iba gastando la flota: con
    // los pedidos reales del 04/09 consumía los 4 camiones en la zona 10 y dejaba 18 pedidos
    // de las otras zonas afuera. Un camión hace varios viajes.
    const s = sugerirRepartos([ped(8000, 10), ped(8000, 10)], FLOTA);
    expect(s.sin_camion).toHaveLength(0);
    expect(s.repartos).toHaveLength(2);
    for (const r of s.repartos) expect(r.camion!.capacidad_kg).toBe(12000);
    expect(s.viajes_por_camion).toEqual([{ camion: 'Camión 12.000', viajes: 2, kg: 16000 }]);
  });

  it('🔴 ningún reparto se pasa de la capacidad de su camión', () => {
    const s = sugerirRepartos([ped(4000), ped(4000), ped(4000), ped(4000)], FLOTA);
    for (const r of s.repartos) {
      expect(r.kg).toBeLessThanOrEqual(r.camion!.capacidad_kg);
      expect(r.ocupacion).toBeLessThanOrEqual(100);
    }
  });

  it('🔴 UN SOLO CLIENTE que llena un camión sale marcado como envío especial', () => {
    // "por ahí un cliente pidió 12.000 kilos él solo y se lo envía en un camión sólo para él".
    const s = sugerirRepartos([ped(11500, 4, 'MAYORISTA SA')], FLOTA);
    expect(s.repartos).toHaveLength(1);
    expect(s.repartos[0].envio_especial).toBe(true);
    expect(s.repartos[0].camion!.capacidad_kg).toBe(12000);
  });

  it('🔴 un pedido MÁS GRANDE que el camión más grande NO se mete a la fuerza', () => {
    // Necesita otra solución (partirlo, un flete). Meterlo igual sería mentirle al galpón.
    const s = sugerirRepartos([ped(15000, 4, 'GRANDOTE SA'), ped(1000, 4)], FLOTA);
    expect(s.sin_camion).toHaveLength(1);
    expect(s.sin_camion[0].cliente_nombre).toBe('GRANDOTE SA');
    expect(s.repartos.every(r => r.pedidos.every(p => p.kg <= 12000))).toBe(true);
  });

  it('🔴 más kilos que la flota: se dice cuántos VIAJES hacen falta, y no se pierde nadie', () => {
    // "hay veces que la totalidad de la flota no da los kilos" (49.000 contra 31.000). Eso no
    // significa que no entren: significa que hay que hacer más viajes o pasar pedidos a otro
    // día. El dato que decide eso es `viajes_por_camion`, no un "no entra".
    const muchos = Array.from({ length: 10 }, () => ped(4900, 4));
    const s = sugerirRepartos(muchos, FLOTA);
    const repartidos = s.repartos.reduce((acc, r) => acc + r.pedidos.length, 0);
    expect(repartidos).toBe(10);          // no se pierde ninguno
    expect(s.sin_camion).toHaveLength(0); // todos entran en ALGÚN camión
    expect(s.total_kg).toBe(49000);
    const viajes = s.viajes_por_camion.reduce((acc, v) => acc + v.viajes, 0);
    expect(viajes).toBeGreaterThan(4);    // más viajes que camiones: no entra en un turno
  });

  it('🔴 los pedidos pesados entran primero: si no, uno grande se queda afuera al pedo', () => {
    // Con 5.000 y 7.000 disponibles: si entrara primero el de 1.000 al camión de 5.000, el de
    // 6.500 igual entraría en el de 7.000. Pero con más pedidos chicos el grande se queda sin
    // lugar teniendo capacidad de sobra. Por eso van los pesados primero.
    const s = sugerirRepartos([ped(1000, 4), ped(6500, 4), ped(1200, 4)], FLOTA);
    expect(s.sin_camion).toHaveLength(0);
    const conElGrande = s.repartos.find(r => r.pedidos.some(p => p.kg === 6500))!;
    expect(conElGrande.camion!.capacidad_kg).toBeGreaterThanOrEqual(6500);
  });

  it('🔴 a cada reparto le queda el camión MÁS CHICO que lo aguante', () => {
    // Con los pedidos reales del 04/09, el camión de 12.000 salía con 3.624 kg (30%) lleno de
    // pedidos chicos porque lo había elegido el primer pedido, el más pesado. Mandar el camión
    // grande a medio llenar es plata.
    const s = sugerirRepartos([ped(4500, 4), ped(200, 4), ped(100, 4)], FLOTA);
    expect(s.repartos).toHaveLength(1);
    expect(s.repartos[0].kg).toBe(4800);
    expect(s.repartos[0].camion!.capacidad_kg).toBe(5000);   // no el de 7.000 ni el de 12.000
    expect(s.repartos[0].ocupacion).toBe(96);
  });

  it('🔴 no mezcla zonas en un mismo reparto', () => {
    // Un camión que va a Lules no pasa por Yerba Buena de paso.
    const s = sugerirRepartos([ped(1000, 9), ped(1000, 13), ped(1000, 9)], FLOTA);
    for (const r of s.repartos) {
      const zonas = new Set(r.pedidos.map(p => p.cod_zona));
      expect(zonas.size).toBe(1);
    }
  });

  it('🔴 la zona MÁS PESADA elige camión primero', () => {
    // Si una zona liviana se queda con el camión de 12.000, la pesada no tiene dónde entrar.
    const s = sugerirRepartos([ped(11000, 10), ped(900, 13)], FLOTA);
    const pesada = s.repartos.find(r => r.cod_zona === 10)!;
    expect(pesada.camion!.capacidad_kg).toBe(12000);
    expect(s.sin_camion).toHaveLength(0);
  });

  it('los pedidos sin zona se agrupan entre ellos y no se pierden', () => {
    const s = sugerirRepartos([ped(1000, null), ped(1000, 9), ped(1000, null)], FLOTA);
    const sinZona = s.repartos.find(r => r.cod_zona == null)!;
    expect(sinZona.pedidos).toHaveLength(2);
  });

  it('sin pedidos no explota', () => {
    const s = sugerirRepartos([], FLOTA);
    expect(s.repartos).toEqual([]);
    expect(s.total_kg).toBe(0);
  });

  it('sin camiones, todo queda sin camión (y no se pierde nada)', () => {
    const s = sugerirRepartos([ped(100), ped(200)], []);
    expect(s.sin_camion).toHaveLength(2);
    expect(s.capacidad_total_kg).toBe(0);
  });
});
