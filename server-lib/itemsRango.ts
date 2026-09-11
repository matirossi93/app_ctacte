import { fetchVentasItems } from './infomanager.js';
export async function itemsPorFechas(fechas: string[], actualizar = false) {
  const dias = [...new Set(fechas)].sort();
  const items: any[] = [], dias_faltantes: string[] = [];
  for (let i = 0; i < dias.length; i += 4) {
    await Promise.all(dias.slice(i, i + 4).map(async dia => {
      try { items.push(...await fetchVentasItems(dia, dia, { actualizar })); }
      catch { dias_faltantes.push(dia); }
    }));
  }
  return { items, dias_faltantes: dias_faltantes.sort(), completo: dias_faltantes.length === 0 };
}
