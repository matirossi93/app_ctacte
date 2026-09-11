"""Arranca PostgreSQL17 aislado, aplica migraciones y prueba concurrencia real.

No usa credenciales, puertos, volúmenes ni bases del usuario. Requiere Docker.
Uso: python3 tests/reparto/run-db-tests.py /ruta/al/repo
"""
from pathlib import Path
import subprocess
import sys
import time
import uuid

repo = Path(sys.argv[1]).resolve()
tests = Path(__file__).resolve().parent
container = 'ctacte-audit-db-' + uuid.uuid4().hex[:12]
legacy = [
    '032_hojas_ruta.sql', '033_hojas_ruta_impresion_facturacion.sql',
    '034_circuito_tres_etapas.sql', '035_facturacion_por_presupuesto.sql',
    '036_ajustes_de_entrega.sql', '037_fecha_del_comprobante_en_la_hoja.sql',
    '038_correcciones_de_factura.sql',
]
new = ['039_integridad_facturacion.sql', '040_integridad_reparto.sql', '041_integridad_fiscal_cruzada.sql']
# La lista es explícita: existen dos migraciones históricas con prefijo 035.
bootstrap = '''CREATE ROLE service_role BYPASSRLS;
CREATE ROLE anon;
CREATE ROLE authenticated;
-- Supabase concede estos permisos por defecto a las tablas públicas.
-- RLS y los GRANT de funciones de cada migración siguen siendo obligatorios.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
CREATE TABLE usuarios(id uuid PRIMARY KEY);
CREATE TABLE pedidos_vendedor(id uuid PRIMARY KEY);
'''

def apply(content):
    subprocess.run(['docker','exec','-i',container,'psql','-U','postgres','-v','ON_ERROR_STOP=1'], input=content, text=True, check=True, stdout=subprocess.DEVNULL)

subprocess.run(['docker','run','--rm','-d','--name',container,'--network','none','--tmpfs','/var/lib/postgresql/data','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17-alpine'],check=True,stdout=subprocess.DEVNULL)
try:
    for _ in range(50):
        r = subprocess.run(['docker','exec',container,'pg_isready','-h','127.0.0.1','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        if r.returncode == 0:
            break
        time.sleep(.2)
    else:
        raise RuntimeError('PostgreSQL temporal no inició')
    apply(bootstrap)
    for migration in legacy:
        apply((repo/'supabase'/'migrations'/migration).read_text())
    apply((tests/'db-legacy-fixtures.sql').read_text())
    for migration in new:
        apply((repo/'supabase'/'migrations'/migration).read_text())
    # Aplicar otra vez detecta migraciones que fallan cuando se reanudan.
    for migration in new:
        apply((repo/'supabase'/'migrations'/migration).read_text())
    subprocess.run([sys.executable,str(tests/'db-legacy-checks.py'),container],check=True)
    subprocess.run([sys.executable,str(tests/'db-regresiones.py'),container],check=True)
    subprocess.run([sys.executable,str(tests/'db-hojas-regresiones.py'),container],check=True)
    subprocess.run([sys.executable,str(tests/'db-cruce-notas.py'),container],check=True)
    subprocess.run([sys.executable,str(tests/'db-readiness-checks.py'),container],check=True)
finally:
    subprocess.run(['docker','stop','--time','5',container],stdout=subprocess.DEVNULL,check=False)
