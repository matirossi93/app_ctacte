"""Verifica imagen sin red, credenciales, puertos ni volúmenes reales. Requiere imagen construida."""
import json
import subprocess
import sys
import time
import uuid

image = sys.argv[1]
expected = sys.argv[2]
assert len(expected) == 64 and all(c in '0123456789abcdef' for c in expected)
container = 'ctacte-audit-image-' + uuid.uuid4().hex[:12]
checks = []
def check(name, condition):
    assert condition, name
    checks.append(name)
def execute(script):
    return subprocess.run(['docker', 'exec', container, 'node', '-e', script],
                          text=True, capture_output=True, check=True).stdout.strip()

subprocess.run(['docker', 'run', '-d', '--name', container, '--network', 'none',
                '--tmpfs', '/app/data:uid=1000,gid=1000,mode=0700',
                '-e', 'PREWARM_BOOT=off', '-e', 'SYNC_ON_START=false',
                '-e', 'INFOMANAGER_CLIENT_SECRET=fixture-with-no-network',
                '-e', 'JWT_SECRET=fixture-local-without-real-credentials',
                '-e', 'INFOMANAGER_USUARIO=fixture-usuario',
                '-e', 'BOT_API_TOKEN=fixture-bot-sin-red',
                image], check=True, stdout=subprocess.DEVNULL)
try:
    for _ in range(90):
        try:
            health = json.loads(execute("fetch('http://127.0.0.1:80/healthz').then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()})))"))
            break
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            state=subprocess.run(['docker','inspect',container,'--format','{{.State.Running}}'],text=True,capture_output=True)
            if state.stdout.strip()!='true':
                logs=subprocess.run(['docker','logs','--tail','40',container],text=True,capture_output=True)
                raise AssertionError('El proceso no inició: '+logs.stdout+logs.stderr)
            time.sleep(1)
    else:
        # Entorno entero de fixture: estos logs nunca incluyen secretos reales.
        logs = subprocess.run(['docker','logs','--tail','40',container],text=True,capture_output=True)
        raise AssertionError('La imagen no inició: '+logs.stdout+logs.stderr)
    check('liveness200 identifica exactamente la compilación', health['status'] == 200 and health['body']['version'] == expected)
    data = json.loads(execute("fetch('http://127.0.0.1:80/readyz').then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()})))"))
    check('readiness503 si falta Supabase, sin consultar IM', data['status'] == 503 and data['body']['listo'] is False)
    statuses = json.loads(execute("const jwt=require('jsonwebtoken');const token=jwt.sign({sub:'10000000-0000-0000-0000-000000000099',rol:'administrativo',email:'fixture@example.invalid'},process.env.JWT_SECRET,{expiresIn:60});Promise.all(['presupuestos','facturacion','hojas-ruta','retiros','pedidos'].map(async p=>{const r=await fetch('http://127.0.0.1:80/api/'+p,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});return [p,r.status]})).then(x=>console.log(JSON.stringify(x)))"))
    check('gate montado en las cinco familias de escritura del servidor real', all(code == 503 for _,code in statuses))
    config = json.loads(execute("console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),env:process.env.NODE_ENV}))"))
    check('el proceso corre como node1000, no root', config['uid'] == 1000 and config['gid'] == 1000)
    check('NODE_ENV de producción', config['env'] == 'production')
    execute("const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/app/data/database.sqlite');d.exec('CREATE TABLE smoke_reparto(id INTEGER PRIMARY KEY, valor TEXT)');d.prepare('INSERT INTO smoke_reparto VALUES(?,?)').run(1,'ok');if(d.prepare('SELECT valor FROM smoke_reparto WHERE id=1').get().valor!=='ok')throw Error('SQLite');d.close();require('node:fs').writeFileSync('/app/data/uploads-tmp/fixture.txt','ok');")
    check('SQLite y subida temporal escriben con uid1000', True)
    metadata = json.loads(execute("const fs=require('node:fs');console.log(JSON.stringify({files:fs.readdirSync('/app'),info:JSON.parse(fs.readFileSync('/app/dist-server/build-info.json','utf8'))}))"))
    check('la imagen no contiene .env, git ni código fuente TypeScript', not any(n.startswith('.env') or n in ['.git','src','server-lib','server.ts'] for n in metadata['files']))
    check('metadata incluye esquema41 y hash esperado', metadata['info'] == {'version': expected, 'schema': 41})
    state = json.loads(subprocess.run(['docker','inspect',container,'--format','{{json .HostConfig}}'],text=True,capture_output=True,check=True).stdout)
    check('contenedor realmente aislado sin red', state['NetworkMode'] == 'none')
    print(json.dumps({'scope':'imagen real, red deshabilitada, datos efímeros','passed':len(checks),'checks':checks},ensure_ascii=False,indent=2))
finally:
    subprocess.run(['docker','rm','-f',container],stdout=subprocess.DEVNULL,check=False)
