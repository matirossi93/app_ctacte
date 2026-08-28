/**
 * Test aislado de la logica de sesion de app_ctacte: replica usuarioDeLaSesion()
 * y prueba las combinaciones reales sin levantar el server entero.
 *
 * Lo que se valida: que la app siga andando como app INDEPENDIENTE (login propio)
 * y ademas acepte a quien viene del PANEL (cookie del dominio compartido).
 */
import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = 'test-secret';
const verifyJwt = (t) => { try { return jwt.verify(t, SECRET); } catch { return null; } };
const COOKIE_PANEL = 'semillero_sesion';

function cookieDelPanel(req) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const parte of raw.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === COOKIE_PANEL && v.length) return decodeURIComponent(v.join('='));
  }
  return null;
}

function usuarioDeLaSesion(req) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const p = verifyJwt(auth.slice(7));
    if (p) return p;
  }
  const ck = cookieDelPanel(req);
  return ck ? verifyJwt(ck) : null;
}

const bueno = jwt.sign({ email: 'test@semillero', rol: 'vendedor' }, SECRET, { expiresIn: '1h' });
const vencido = jwt.sign({ email: 'test@semillero', rol: 'vendedor' }, SECRET, { expiresIn: -10 });

const casos = [
  ['1. viene del panel (solo cookie)', { cookie: `${COOKIE_PANEL}=${bueno}` }, true],
  ['2. vendedor con su login propio', { authorization: `Bearer ${bueno}` }, true],
  ['3. sin nada: debe pedir login', {}, false],
  ['4. token VENCIDO pero viene del panel', { authorization: `Bearer ${vencido}`, cookie: `${COOKIE_PANEL}=${bueno}` }, true],
  ['5. token vencido y sin panel', { authorization: `Bearer ${vencido}` }, false],
  ['6. cookie con basura', { cookie: `${COOKIE_PANEL}=no-es-un-token` }, false],
  ['7. otras cookies, ninguna del panel', { cookie: 'otra=x; mas=y' }, false],
  ['8. cookie del panel entre otras', { cookie: `otra=x; ${COOKIE_PANEL}=${bueno}; mas=y` }, true],
];

// 🪤 Esto corria como script suelto (console.log + process.exit) pero el archivo se llama
// `.test.mjs`, asi que vitest lo levantaba y el `process.exit(0)` le hacia fallar la suite
// entera: `npm test` quedaba en rojo con los 8 casos pasando. Los mismos 8 casos, como test.
describe('usuarioDeLaSesion — login propio y sesion del panel', () => {
  it.each(casos)('%s', (_nombre, headers, esperado) => {
    expect(!!usuarioDeLaSesion({ headers })).toBe(esperado);
  });
});
