export type EtapaReparto = 'presupuestos' | 'fraccionado' | 'facturacion' | 'hojas';
export function fechaValida(d: string) { return /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().slice(0,10) === d; }
export function rangoValido(d: string, h: string) { return fechaValida(d) && fechaValida(h) && d <= h && Date.parse(`${h}T12:00:00Z`) - Date.parse(`${d}T12:00:00Z`) <= 31 * 864e5; }
export function contextoReparto(search: string, hoy: string) {
  const q = new URLSearchParams(search), etapa = q.get('etapa');
  const desde = q.get('desde') ?? '', hasta = q.get('hasta') ?? '';
  const hoja = q.get('hoja');
  return { etapa: (['presupuestos','fraccionado','facturacion','hojas'].includes(etapa ?? '') ? etapa : 'presupuestos') as EtapaReparto,
    rango: rangoValido(desde, hasta) ? {desde,hasta} : {desde:hoy,hasta:hoy},
    hoja: hoja && /^[a-zA-Z0-9-]{1,80}$/.test(hoja) ? hoja : null };
}
