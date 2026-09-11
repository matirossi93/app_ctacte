"""Comprueba permisos/capacidades reales del gate con el rol de la aplicación."""
import json
import subprocess
import sys

container = sys.argv[1]
assert container.startswith('ctacte-audit-db-')
checks = []

def probe(name, change='', expected=True):
    query = f"""BEGIN;
{change}
SET LOCAL ROLE service_role;
SELECT reparto_estado_esquema();
ROLLBACK;
"""
    p = subprocess.run(['docker', 'exec', container, 'psql', '-U', 'postgres',
                        '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', query],
                       text=True, capture_output=True, check=True)
    answer = json.loads(p.stdout.strip())
    assert answer['version'] == 41 and answer['version_cierre'] == 42 and answer['listo'] is expected, (name, answer)
    checks.append(name)

probe('esquema completo listo para service_role')
probe('INSERT de notas es obligatorio aunque SELECT siga disponible',
      'REVOKE INSERT ON facturas_correcciones FROM service_role;', False)
probe('DELETE de aprobaciones es obligatorio',
      'REVOKE DELETE ON presupuestos_revision FROM service_role;', False)
probe('columna de procedencia requerida',
      'ALTER TABLE hojas_ruta_pedidos DROP COLUMN empresa_fuente;', False)
probe('no permite RPC financiera pública',
      'GRANT EXECUTE ON FUNCTION tomar_paso_factura(uuid,uuid,integer,uuid) TO anon;', False)
probe('no permite RPC de hoja pública',
      'GRANT EXECUTE ON FUNCTION mutar_reparto(uuid,uuid,text,jsonb) TO authenticated;', False)
probe('requiere RLS también en notas históricas',
      'ALTER TABLE facturas_correcciones DISABLE ROW LEVEL SECURITY;', False)
probe('función requerida ausente rechaza preparación',
      'ALTER FUNCTION tomar_remito(uuid,text,uuid) RENAME TO temporal_sin_tomar_remito;', False)
probe('trigger de corrección deshabilitado impide preparación',
      'ALTER TABLE facturas_operaciones DISABLE TRIGGER integridad_correccion_entrega;', False)
probe('trigger de vínculo faltante impide preparación',
      'DROP TRIGGER integridad_vinculo_correccion ON hojas_ruta_ajustes;', False)
probe('mutex requiere UPDATE para SELECT FOR UPDATE',
      'REVOKE UPDATE ON reparto_control FROM service_role;', False)
probe('trigger sólo UPDATE no reemplaza guard INSERT+UPDATE',
      'DROP TRIGGER integridad_vinculo_correccion ON hojas_ruta_ajustes; CREATE TRIGGER integridad_vinculo_correccion BEFORE UPDATE OF im_ajuste_id,im_comprobante_id ON hojas_ruta_ajustes FOR EACH ROW EXECUTE FUNCTION controlar_vinculo_correccion();', False)
probe('evidencia durable del resultado remoto es requerida',
      'ALTER TABLE facturas_operaciones DROP COLUMN resultado_por_conciliar;', False)
probe('trigger recíproco de checkpoint es requerido',
      'ALTER TABLE facturas_correcciones DISABLE TRIGGER integridad_checkpoint_vinculo;', False)
probe('los cambios de verificación se revierten')
for role in ['anon', 'authenticated']:
    p = subprocess.run(['docker', 'exec', container, 'psql', '-U', 'postgres',
                        '-Atq', '-v', 'ON_ERROR_STOP=1', '-c',
                        f'SET ROLE {role}; SELECT reparto_estado_esquema();'],
                       text=True, capture_output=True)
    assert p.returncode != 0 and 'permission denied' in p.stderr, (role, p.stderr)
    checks.append('diagnóstico de esquema no accesible por '+role)
print(json.dumps({'scope': 'readiness SQL real con permisos por rol', 'passed': len(checks),
                  'checks': checks}, ensure_ascii=False, indent=2))

probe('requiere respaldo de importes al cierre', 'ALTER TABLE hojas_ruta DROP COLUMN cierres_importes;', False)
probe('cierre de importes no permite ejecución pública', 'GRANT EXECUTE ON FUNCTION cerrar_hoja_con_importes(uuid,uuid,jsonb) TO anon;', False)
