/** Servidor local y fixtures cerradas: jamás usa la configuración E2E de producción. */
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(process.env.REPARTO_TEST_REPO || process.argv[2] || '.');
const tests = path.dirname(fileURLToPath(import.meta.url));
const port = 4189;
const base = `http://127.0.0.1:${port}`;
const output = path.resolve(process.env.REPARTO_TEST_OUTPUT || path.join(repo, 'tests/artifacts-reparto'));
await mkdir(output, { recursive: true });
const env = { ...process.env, REPARTO_TEST_REPO: repo, REPARTO_TEST_URL: base, REPARTO_TEST_OUTPUT: output };
const preview = spawn(process.execPath, [path.join(repo,'node_modules/vite/bin/vite.js'),'preview','--host','127.0.0.1','--port',String(port),'--strictPort'], { cwd: repo, env, stdio: ['ignore','pipe','pipe'] });
let startup = '';
preview.stdout.on('data', b => { startup = (startup + b).slice(-6000); });
preview.stderr.on('data', b => { startup = (startup + b).slice(-6000); });
let failed = false;
preview.on('error', () => { failed = true; });
preview.on('exit', () => { failed = true; });
async function run(file) {
  const p = spawn(process.execPath, [path.join(tests,file)], { cwd: repo, env, stdio: 'inherit' });
  const code = await new Promise((resolve,reject) => { p.on('error',reject); p.on('exit',resolve); });
  if (code !== 0) throw new Error(`Falló ${file} (salida ${code})`);
}
try {
  let ready = false;
  for(let i=0;i<100;i++) {
    if (failed) throw new Error(`El preview no pudo iniciar: ${startup}`);
    if (stripVTControlCharacters(startup).includes(`127.0.0.1:${port}`)) {
      const r = await fetch(base + '/reparto').catch(() => null);
      if (r?.ok && (await r.text()).includes('id="root"')) { ready=true; break; }
    }
    await new Promise(r => setTimeout(r,200));
  }
  if (!ready) throw new Error(`El preview no estuvo listo: ${startup}`);
  const allowed = ['browser-regresiones.mjs','browser-finanzas.mjs','browser-operaciones.mjs','browser-impresion.mjs','browser-contexto.mjs','browser-listas.mjs','browser-pedido-rechazado.mjs'];
  const scripts = process.env.REPARTO_BROWSER_ONLY ? [process.env.REPARTO_BROWSER_ONLY] : allowed;
  if (scripts.some(s=>!allowed.includes(s))) throw new Error('Fixture de navegador desconocida');
  for (const script of scripts) await run(script);
} finally {
  if (preview.exitCode === null) {
    const ended = new Promise(r => preview.once('exit',r));
    preview.kill('SIGTERM');
    const timer = setTimeout(() => preview.kill('SIGKILL'), 3000);
    await ended;
    clearTimeout(timer);
  }
}
