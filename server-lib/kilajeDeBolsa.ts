import type { Request, Response } from 'express';
import type { JwtPayload } from './auth.js';
import { sb, TENANT_ID } from './supabase.js';
import { invalidarFormatosManuales } from './formatosBolsa.js';

/**
 * CUÁNTOS KILOS TRAE LA BOLSA DE UN PRODUCTO, cargado por quien la tiene enfrente.
 *
 * Mati (17/09/2026): *"el tema del camino A es que van cambiando los kilajes de las bolsas, no
 * son siempre iguales... cómo hacemos ahí? instantánea ahora tiene 20, arrollada por 30 y el
 * sorgo por 40"*.
 *
 * 🔑 Sin este dato el fraccionado no puede decidir nada: 40 kg de sorgo son UNA bolsa cerrada o
 * cuatro paquetes de 10 según cuánto traiga la bolsa, y la diferencia es trabajo real para el
 * sector. InfoManager no lo tiene —un granel sale con `unidad_de_medida: Kilos` y
 * `equivalencia_um: 1`— y deducirlo de los pedidos falla justo en los que se venden poco.
 *
 * Va sin `requireAdmin`, igual que el resto de la pantalla: el que ve la bolsa es el que está
 * armando el pedido, y hacerle pedir el cambio a otro es lo que mantuvo el número viejo dos días.
 */
const MAX_KG = 2000;

export async function guardarKilajeDeBolsa(req: Request & { user?: JwtPayload }, res: Response) {
  const cod = Number(req.params.cod);
  if (!Number.isInteger(cod) || cod <= 0) {
    res.status(400).json({ error: 'Código de artículo inválido.' }); return;
  }
  const crudo = req.body?.kg;
  // 🔑 `null` es un valor con sentido: "no sé cuánto trae" — y es distinto de no mandar nada.
  const borrar = crudo === null || crudo === '';
  const kg = borrar ? null : Number(crudo);
  if (!borrar && !(Number.isFinite(kg as number) && (kg as number) > 0 && (kg as number) <= MAX_KG)) {
    res.status(400).json({ error: `El kilaje tiene que ser un número entre 0 y ${MAX_KG}.` }); return;
  }
  try {
    const { error } = borrar
      ? await sb().from('formatos_bolsa').delete().eq('tenant_id', TENANT_ID).eq('cod_articulo', cod)
      : await sb().from('formatos_bolsa').upsert({
          tenant_id: TENANT_ID, cod_articulo: cod, kg,
          actualizado_por: req.user?.sub ?? null, actualizado_at: new Date().toISOString(),
        });
    if (error) throw new Error(error.message);
    // 🪤 Sin esto, el que acaba de escribir 40 sigue viendo el listado partido en paquetes de 10
    // hasta que venza el cache. El cambio se hace justo para ver el resultado.
    invalidarFormatosManuales();
    res.json({ ok: true, cod_articulo: cod, kg });
  } catch (err: any) {
    console.error('[guardarKilajeDeBolsa]', err?.message ?? err);
    res.status(502).json({ error: `No pude guardar el kilaje: ${err?.message ?? 'sin respuesta'}` });
  }
}
