/** La identidad y el esquema deben coincidir: un200 del SPA anterior no es un despliegue. */
const expected = process.env.EXPECTED_BUILD;
if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Falta EXPECTED_BUILD válido');
const base = process.env.REPARTO_DEPLOY_URL || 'https://clientes.semilleroelmanantial.com.ar';
const url = new URL('/readyz', base);
if (url.protocol !== 'https:') throw new Error('La verificación publicada requiere HTTPS');
const started = Date.now();
let last = 'sin respuesta';
while (Date.now() - started < 9 * 60_000) {
  try {
    const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(7000) });
    if (!response.headers.get('content-type')?.includes('application/json')) last = 'la respuesta no es el endpoint de preparación';
    else {
      const state = await response.json();
      if (response.status === 200 && state.listo === true && state.esquema_listo === true && state.esquema_requerido === 41 && state.version === expected) {
        console.log('Despliegue verificado: versión esperada y esquema41 listo.');
        process.exit(0);
      }
      last = `HTTP ${response.status}, identidad ${state.version === expected ? 'esperada' : 'distinta'}, esquema ${state.esquema_listo === true ? 'listo' : 'pendiente'}`;
    }
  } catch { last = 'endpoint de preparación sin respuesta válida'; }
  console.log('Esperando despliegue: '+last);
  await new Promise(resolve => setTimeout(resolve, 10_000));
}
throw new Error('No se verificó el despliegue dentro del plazo: '+last);
