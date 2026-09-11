import https from 'node:https';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

export function estadoEsperado(state, expected) {
  return state?.listo === true && state.esquema_listo === true && state.esquema_requerido === 42 && state.version === expected;
}

/** Conserva Host/SNI y la validación del certificado al consultar el origen. */
export function leerPreparacion(url, origin) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'Cache-Control': 'no-cache', Accept: 'application/json' },
      signal: AbortSignal.timeout(7000),
      ...(origin ? { lookup: (_host, options, done) => {
        const family = isIP(origin);
        if (options.all) done(null, [{ address: origin, family }]);
        else done(null, origin, family);
      } } : {}),
    }, response => {
      const chunks = []; let size = 0;
      response.on('data', b => {
        size += b.length;
        if (size > 65536) { request.destroy(new Error('Respuesta de preparación demasiado grande')); return; }
        chunks.push(b);
      });
      response.on('error', reject);
      response.on('end', () => {
        const type = response.headers['content-type'] || '';
        let state = null;
        if (type.includes('application/json')) {
          try { state = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* se informa como no válido */ }
        }
        resolve({ status: response.statusCode, state, diagnostico: `HTTP ${response.statusCode}, tipo ${type || 'sin tipo'}, servidor ${response.headers.server || 'sin identificar'}` });
      });
    });
    request.on('error', reject);
  });
}

async function main() {
  const expected = process.env.EXPECTED_BUILD;
  if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Falta EXPECTED_BUILD válido');
  const url = new URL('/readyz', process.env.REPARTO_DEPLOY_URL || 'https://clientes.semilleroelmanantial.com.ar');
  if (url.protocol !== 'https:') throw new Error('La verificación publicada requiere HTTPS');
  const origin = process.env.REPARTO_DEPLOY_ORIGIN;
  if (origin && !isIP(origin)) throw new Error('REPARTO_DEPLOY_ORIGIN debe ser una IP válida');
  const started = Date.now(); let last = 'sin respuesta';
  while (Date.now() - started < 9 * 60_000) {
    for (const target of origin ? [undefined, origin] : [undefined]) {
      try {
        const r = await leerPreparacion(url, target);
        if (r.status === 200 && estadoEsperado(r.state, expected)) {
          if (target) console.log(`::warning::Verificación pública desde este runner no disponible (${last}). Se verificó el origen por HTTPS con certificado y hostname válidos.`);
          console.log(`Despliegue verificado${target ? ' en origen' : ' en URL pública'}: versión esperada y esquema 42 listo.`);
          return;
        }
        last = `${target ? 'origen' : 'público'}: ${r.diagnostico}; identidad ${r.state?.version === expected ? 'esperada' : 'distinta o ausente'}`;
      } catch (e) { last = `${target ? 'origen' : 'público'}: ${e.message}`; }
    }
    console.log('Esperando despliegue: ' + last);
    await new Promise(r => setTimeout(r, 10_000));
  }
  throw new Error('No se verificó el despliegue dentro del plazo: ' + last);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
