/**
 * SQL revisable para el SQL Editor: vincular notas existentes (043).
 *
 * Generar NO ejecuta ni conecta con ninguna base. Mismo patrón que
 * `preparar-migracion-reparto.mjs`: procedencia por SHA256, una sola transacción y una
 * verificación que REVIERTE si el resultado no es el esperado.
 *
 * 🔑 La verificación exige dos cosas a la vez: que la capacidad nueva quede acreditada y que
 * `listo` —lo que mira la app YA PUBLICADA— siga siendo true. Aplicar esto no puede dejar la
 * facturación en 503 mientras el código nuevo todavía no salió.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = path.resolve(process.argv[2] || '.');
const name = '043_notas_existentes_nd.sql';
const content = await readFile(path.join(root, 'supabase/migrations', name), 'utf8');

if (!content.includes("'version_vinculo',43")) throw new Error('La 043 debe declarar su capacidad antes de preparar el release.');
const inicio = content.indexOf('begin;');
const fin = content.lastIndexOf('commit;');
if (inicio < 0 || fin < 0) throw new Error('La 043 debe venir en una transacción.');
const cuerpo = content.slice(inicio + 'begin;'.length, fin).trim();
const cola = content.slice(fin + 'commit;'.length).trim();

process.stdout.write([
  '-- Reparto: vincular notas existentes (NC y ND). Ejecutar completa antes de publicar el código.',
  '-- No consulta InfoManager, no emite comprobantes y no toca stock.',
  '-- Si la verificación final no da lo esperado, se revierte TODO y la base queda como estaba.',
  '-- Procedencia SHA256: ' + name + ' ' + createHash('sha256').update(content).digest('hex'),
  '',
  'BEGIN;',
  "SET LOCAL lock_timeout='5s';",
  "SET LOCAL statement_timeout='120s';",
  '',
  cuerpo,
  '',
  `DO $$
DECLARE estado jsonb;
BEGIN
  estado := reparto_estado_esquema();
  IF NOT coalesce((estado->>'vinculo_listo')::boolean,false) OR (estado->>'version_vinculo')::int IS DISTINCT FROM 43 THEN
    RAISE EXCEPTION 'No se acreditó la capacidad de vínculo: %. Se revierte esta instalación.',estado;
  END IF;
  -- La app publicada mira esto. Si se cayera, quedaría en 503 toda la facturación.
  IF NOT coalesce((estado->>'listo')::boolean,false) OR (estado->>'version')::int IS DISTINCT FROM 41
     OR (estado->>'version_cierre')::int IS DISTINCT FROM 42 THEN
    RAISE EXCEPTION 'La preparación 41/42 dejó de estar lista: %. Se revierte esta instalación.',estado;
  END IF;
END $$;`,
  'SELECT reparto_estado_esquema();',
  'COMMIT;',
  '',
  cola,
  '',
].join('\n'));
