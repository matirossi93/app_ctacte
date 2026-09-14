/**
 * SQL revisable para el SQL Editor: el rótulo de la hoja (044).
 *
 * Generar NO ejecuta ni conecta con ninguna base. Mismo molde que
 * `preparar-migracion-notas.mjs`: procedencia por SHA256, una sola transacción y una verificación
 * que REVIERTE si el resultado no es el esperado.
 *
 * 🔑 La verificación exige la capacidad nueva Y que siga en pie todo lo anterior: esta migración
 * reemplaza `mutar_reparto` entera, que es la función por la que pasan TODAS las escrituras de
 * reparto. Si algo de 41/42/43 dejara de estar listo, la instalación se revierte sola.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = path.resolve(process.argv[2] || '.');
const name = '044_nombre_de_la_hoja.sql';
const content = await readFile(path.join(root, 'supabase/migrations', name), 'utf8');

if (!content.includes('nombre=origen.nombre')) throw new Error('La 044 debe escribir el rótulo en hoja_editar antes de preparar el release.');
if (!content.includes("'version_nombre',44")) throw new Error('La 044 debe declarar su capacidad antes de preparar el release.');
const inicio = content.indexOf('begin;');
const fin = content.lastIndexOf('commit;');
if (inicio < 0 || fin < 0) throw new Error('La 044 debe venir en una transacción.');

process.stdout.write([
  '-- Reparto: un nombre para la hoja, además del número. Ejecutar completa antes de publicar el código.',
  '-- No consulta InfoManager, no emite comprobantes y no toca stock.',
  '-- Si la verificación final no da lo esperado, se revierte TODO y la base queda como estaba.',
  '-- Procedencia SHA256: ' + name + ' ' + createHash('sha256').update(content).digest('hex'),
  '',
  'BEGIN;',
  "SET LOCAL lock_timeout='5s';",
  "SET LOCAL statement_timeout='120s';",
  '',
  content.slice(inicio + 'begin;'.length, fin).trim(),
  '',
  `DO $$
DECLARE estado jsonb;
BEGIN
  estado := reparto_estado_esquema();
  IF NOT coalesce((estado->>'nombre_listo')::boolean,false) OR (estado->>'version_nombre')::int IS DISTINCT FROM 44 THEN
    RAISE EXCEPTION 'No se acreditó el rótulo de la hoja: %. Se revierte esta instalación.',estado;
  END IF;
  -- Esta migración reemplaza mutar_reparto: si algo de lo anterior se cayera, no se publica.
  IF NOT coalesce((estado->>'listo')::boolean,false) OR (estado->>'version')::int IS DISTINCT FROM 41
     OR (estado->>'version_cierre')::int IS DISTINCT FROM 42
     OR (estado->>'version_vinculo')::int IS DISTINCT FROM 43
     OR NOT coalesce((estado->>'vinculo_listo')::boolean,false) THEN
    RAISE EXCEPTION 'La preparación anterior dejó de estar lista: %. Se revierte esta instalación.',estado;
  END IF;
END $$;`,
  'SELECT reparto_estado_esquema();',
  'COMMIT;',
  '',
  content.slice(fin + 'commit;'.length).trim(),
  '',
].join('\n'));
