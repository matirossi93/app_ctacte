"""Regresiones reales de PostgreSQL. Sólo contenedor efímero sin red.

Uso: python3 db-regresiones.py [nombre-contenedor]
La base debe contener el esquema 032–039 de la app y roles Supabase simulados.
"""
import concurrent.futures
import json
import subprocess
import sys
import uuid

CONTAINER = sys.argv[1] if len(sys.argv) > 1 else "ctacte-audit-db-20260911"
assert CONTAINER.startswith("ctacte-audit-db-"), "Sólo bases efímeras de esta prueba"
T = str(uuid.uuid4())
USER = str(uuid.uuid4())
checks = []

def sql(query, ok=True):
    p = subprocess.run(["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", query], text=True, capture_output=True)
    if ok and p.returncode:
        raise AssertionError(p.stderr)
    return p.stdout.strip() if ok else p

def lit(value):
    return "'" + str(value).replace("'", "''") + "'"

def js(value):
    return lit(json.dumps(value)) + "::jsonb"

def check(name, condition):
    assert condition, name
    checks.append(name)

sql(f"INSERT INTO usuarios(id) VALUES ({lit(USER)})")
ORIGINAL = [{"cod_articulo": 11, "cantidad": 10, "precio": 100}]
FINAL = [{"cod_articulo": 11, "cantidad": 8, "precio": 100}]
COMPONENTS = [{"datos": {"cod_cliente": 101, "total": 200}}, {"datos": {"cod_cliente": 101, "total": 100}}]

def start(op, factura="FA-LAB", version=0, components=COMPONENTS, final=FINAL, ok=True, petition=None):
    petition = petition or {"numero_factura": 500, "motivo": "prueba aislada", "origen":{"cliente":101,"empresa":1}}
    return sql(f"select iniciar_operacion_factura({lit(T)},{lit(op)},{lit(factura)},{version},'productos',{js(petition)},{js(components)},{js(ORIGINAL)},{js(final)},{lit(USER)})", ok)

op = str(uuid.uuid4())
check("intención persistida antes de emisión", json.loads(start(op))["estado"] == "listo")
check("misma intención recuperable", json.loads(start(op))["id"] == op)
check("clave no acepta otro contenido", start(op, petition={"motivo": "otro"}, ok=False).returncode != 0)
check("otra operación no toma factura ocupada", start(str(uuid.uuid4()), ok=False).returncode != 0)

def take(i, token):
    return sql(f"select tomar_paso_factura({lit(T)},{lit(op)},{i},{lit(token)})", ok=False)

tokens = [str(uuid.uuid4()) for _ in range(8)]
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    responses = list(pool.map(lambda token: take(0, token), tokens))
winners = [t for t, r in zip(tokens, responses) if r.returncode == 0]
check("ocho reclamos concurrentes: un solo ganador", len(winners) == 1)

def finish(token, result=None, uncertain=False, ok=True):
    result_sql = "NULL" if result is None else js(result)
    return sql(f"select terminar_paso_factura({lit(T)},{lit(op)},{lit(token)},{result_sql},'error simulado',{str(uncertain).lower()})", ok)

check("checkpoint rechaza dueño incorrecto", finish(str(uuid.uuid4()), ok=False).returncode != 0)
for invalid in [0,-1,{},'ERROR','12.3',None]:
    check('checkpoint no acepta identificador inválido '+str(invalid), finish(winners[0], {'id':invalid,'numero':501,'tipo':'NC B'}, ok=False).returncode != 0)
nc = {"id": "70000001", "numero": 501, "tipo": "NC B"}
after_nc = json.loads(finish(winners[0], nc))
check("NC queda vinculada antes de intentar ND", sql(f"select count(*) from facturas_correcciones where tenant_id={lit(T)}") == "1")
check("avanza exclusivamente al segundo componente", after_nc["indice"] == 1 and after_nc["estado"] == "listo")
check("no se reclama nuevamente la NC", take(0, str(uuid.uuid4())).returncode != 0)

token_nd = str(uuid.uuid4())
check("ND reclamada", take(1, token_nd).returncode == 0)
check("rechazo definitivo habilita sólo ND", json.loads(finish(token_nd))["estado"] == "listo")
token_nd2 = str(uuid.uuid4())
check("reintento reclama ND", take(1, token_nd2).returncode == 0)
after_nd = json.loads(finish(token_nd2, {"id": "70000002", "numero": 502, "tipo": "ND B"}))
check("operación completa conserva dos componentes", after_nd["estado"] == "completo" and len(after_nd["resultados"]) == 2)
state = json.loads(sql(f"select to_jsonb(e) from facturas_estado_correccion e where tenant_id={lit(T)}"))
check("actualiza versión y renglones corregidos atómicamente", state["version"] == 1 and state["renglones"] == FINAL and state["operacion_id"] is None)
check("repetir operación completa devuelve comprobantes existentes", json.loads(start(op))["resultados"] == after_nd["resultados"])
check("segunda corrección rechaza versión antigua", start(str(uuid.uuid4()), ok=False).returncode != 0)

op = str(uuid.uuid4())
check("siguiente corrección admite versión actual", json.loads(start(op, version=1))["estado"] == "listo")
unknown_token = str(uuid.uuid4())
check("paso incierto reclamado", take(0, unknown_token).returncode == 0)
check("resultado desconocido queda durable", json.loads(finish(unknown_token, uncertain=True))["estado"] == "incierto")
check("no permite reemitir resultado desconocido", take(0, str(uuid.uuid4())).returncode != 0)
check("otro identificador no evade operación incierta", start(str(uuid.uuid4()), version=1, ok=False).returncode != 0)

sql(f"INSERT INTO facturas_correcciones(tenant_id,im_factura_id,cod_cliente,tipo,im_comprobante_id,total) VALUES ({lit(T)},'FA-LEGACY',101,'NC B','NC-LEGACY',100)")
check("notas legacy sin estado no se recalculan como factura original", start(str(uuid.uuid4()), factura="FA-LEGACY", ok=False).returncode != 0)

for role in ("anon", "authenticated"):
    denied = sql(f"SET ROLE {role}; select tomar_paso_factura({lit(T)},{lit(op)},0,{lit(str(uuid.uuid4()))})", ok=False)
    check(f"rol {role} no puede ejecutar emisión", denied.returncode != 0 and "permission denied" in denied.stderr)

def claim_pr(token, activity):
    return sql(f"select reclamar_presupuesto({lit(T)},'PR-LAB',{lit(token)},{lit(activity)})")

pr_tokens = [str(uuid.uuid4()) for _ in range(8)]
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    claims = list(pool.map(lambda pair: claim_pr(pair[1], 'editar' if pair[0] % 2 else 'facturar'), enumerate(pr_tokens)))
check("editar vs facturar: un solo dueño del presupuesto", claims.count('t') == 1)
pr_winner = pr_tokens[claims.index('t')]
check("liberación de presupuesto verifica token", sql(f"select soltar_presupuesto({lit(T)},'PR-LAB',{lit(str(uuid.uuid4()))})") == 'f')
check("no se roba presupuesto después de liberar con token ajeno", claim_pr(str(uuid.uuid4()), 'editar') == 'f')
check("dueño libera operación conocida", sql(f"select soltar_presupuesto({lit(T)},'PR-LAB',{lit(pr_winner)})") == 't')
check("presupuesto liberado se puede volver a tomar", claim_pr(str(uuid.uuid4()), 'editar') == 't')

sql(f"insert into presupuestos_facturados(tenant_id,im_comprobante_id,cod_cliente,im_factura_id,estado_emision) values ({lit(T)},'PR-REM-LAB',101,'FA-REM-LAB','remito_pendiente')")
def claim_re(token):
    return sql(f"select tomar_remito({lit(T)},'PR-REM-LAB',{lit(token)})")

with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    re_claims = list(pool.map(claim_re, [str(uuid.uuid4()) for _ in range(8)]))
check("ocho reintentos de remito: un solo dueño", re_claims.count('t') == 1)
sql(f"update presupuestos_facturados set reclamado_at=now()-interval '1 day' where tenant_id={lit(T)} and im_comprobante_id='PR-REM-LAB'")
check("reclamo de remito no vence con resultado incierto", claim_re(str(uuid.uuid4())) == 'f')

op = str(uuid.uuid4())
start(op, factura="FA-CANCEL")
def cancel(ok=False):
    return sql(f"select cancelar_operacion_factura({lit(T)},{lit(op)})", ok)

check("no se cancela una intención nunca rechazada", cancel().returncode != 0)
token_cancel = str(uuid.uuid4())
take(0, token_cancel)
check("no se cancela una nota mientras se está emitiendo", cancel().returncode != 0)
finish(token_cancel)
check("rechazo definitivo sin notas se puede cancelar", cancel(ok=True) == 't')
check("cancelación conserva operación como rastro", sql(f"select estado from facturas_operaciones where tenant_id={lit(T)} and id={lit(op)}") == 'cancelado')
check("cancelada no vuelve a reclamar POST", take(0, str(uuid.uuid4())).returncode != 0)
check("cancelación permite revisar nueva operación con versión nueva", json.loads(start(str(uuid.uuid4()), factura="FA-CANCEL", version=1))["estado"] == 'listo')

op = str(uuid.uuid4())
start(op, factura="FA-CANCEL-INCIERTO")
token_cancel = str(uuid.uuid4())
take(0, token_cancel)
finish(token_cancel, uncertain=True)
check("cancelar no permite liberar una emisión incierta", cancel().returncode != 0)

print(json.dumps({"scope": "PostgreSQL17 local efímero; ninguna API de negocio", "passed": len(checks), "checks": checks}, ensure_ascii=False, indent=2))
