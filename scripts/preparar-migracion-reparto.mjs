/** SQL revisable para SQL Editor. Generar no ejecuta ni conecta con ninguna base. */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = path.resolve(process.argv[2] || '.');
const names = ['039_integridad_facturacion.sql','040_integridad_reparto.sql','041_integridad_fiscal_cruzada.sql'];
const files = await Promise.all(names.map(async name => ({ name, content: await readFile(path.join(root,'supabase/migrations',name),'utf8') })));
if (!files[2].content.includes('function reparto_estado_esquema()')) throw new Error('041 debe incluir su comprobación de preparación antes de preparar el release.');
const lines = ['-- Reparto: migración transaccional039–041. Ejecutar completa antes de publicar el código.',
  '-- No consulta InfoManager ni emite comprobantes. Si falla la verificación, se revierte esta transacción.',
  '-- Procedencia SHA256 de cada migración:'];
for (const f of files) lines.push('-- '+f.name+' '+createHash('sha256').update(f.content).digest('hex'));
lines.push('', 'BEGIN;', "SET LOCAL lock_timeout='5s';", "SET LOCAL statement_timeout='120s';", '');
for (const f of files) lines.push('-- '+f.name, f.content, '');
lines.push(`DO $$
DECLARE estado jsonb;
BEGIN
  estado := reparto_estado_esquema();
  IF (estado->>'version')::int IS DISTINCT FROM 41 OR NOT coalesce((estado->>'listo')::boolean,false) THEN
    RAISE EXCEPTION 'No se confirmó esquema41 listo: %. Se revierte esta instalación.',estado;
  END IF;
END $$;`, 'SELECT reparto_estado_esquema();', 'COMMIT;', '');
process.stdout.write(lines.join('\n'));
