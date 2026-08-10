/**
 * Indexado determinista de `usuarios` por cod_vendedor.
 *
 * POR QUÉ EXISTE — incidente 10/08/2026:
 * La tabla `usuarios` NO tiene UNIQUE sobre cod_vendedor: 001_panel_vendedor.sql:25
 * crea un índice común, no único (el UNIQUE es por (tenant_id, lower(email))). Todos
 * los call sites resolvían el nombre con `map.set(cod, u)` dentro de un forEach, o sea
 * last-write-wins sobre un SELECT sin ORDER BY — y sin ORDER BY, PostgREST devuelve el
 * orden físico del heap de Postgres, que cambia con cualquier UPDATE.
 *
 * El 31/07/2026 un script de diagnóstico dejó `diag.vendedor@semillero.test`
 * (nombre "DIAG vendedor") con cod_vendedor 12 — el de Brian — y activo=true. Desde
 * entonces el Ranking del equipo mostraba "DIAG vendedor" en el puesto de Brian, con
 * el resto de sus números correctos (target y ventas se buscan por cod, no por usuario).
 *
 * Elegir acá y no con .order() en la query es a propósito: así el criterio queda en un
 * solo lugar, testeable, y no depende de que cada call site se acuerde de ordenar.
 */

/** Lo mínimo que se necesita para desempatar. Los call sites traen más columnas. */
export interface UsuarioCod {
  id?: string | null;
  cod_vendedor?: number | string | null;
  activo?: boolean | null;
  created_at?: string | null;
}

export interface UsuariosPorCod<T> {
  /** Una sola fila por cod_vendedor, elegida con el criterio de abajo. */
  byCod: Map<number, T>;
  /** Cods que venían repetidos, para poder loguearlos. Ordenados asc. */
  dupCods: number[];
}

/** Epoch ms de created_at; sin fecha o fecha corrupta = infinito (pierde el desempate). */
function nacimiento(v: string | null | undefined): number {
  if (!v) return Number.POSITIVE_INFINITY;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/**
 * ¿`a` desplaza a `b` como fila canónica del cod?
 *   1. activo gana sobre inactivo — un duplicado dado de baja nunca pisa al vivo.
 *      (`activo !== false` para que null/undefined cuenten como activo, igual que goals.ts).
 *   2. created_at más viejo gana — el usuario legítimo es el original; los duplicados
 *      aparecen después.
 *   3. id alfabético — desempate final, para que no dependa del orden de entrada.
 */
function desplaza(a: UsuarioCod, b: UsuarioCod): boolean {
  const aActivo = a.activo !== false;
  const bActivo = b.activo !== false;
  if (aActivo !== bActivo) return aActivo;

  const aNace = nacimiento(a.created_at);
  const bNace = nacimiento(b.created_at);
  if (aNace !== bNace) return aNace < bNace;

  return String(a.id ?? '') < String(b.id ?? '');
}

export function usuariosPorCod<T extends UsuarioCod>(
  rows: readonly T[] | null | undefined,
): UsuariosPorCod<T> {
  const byCod = new Map<number, T>();
  const dups = new Set<number>();

  for (const u of rows ?? []) {
    // Ojo: Number(null) y Number('') dan 0, que es un cod válido. Hay que
    // descartarlos antes de convertir, no después.
    if (u == null || u.cod_vendedor == null || u.cod_vendedor === '') continue;
    const cod = Number(u.cod_vendedor);
    if (!Number.isInteger(cod)) continue;

    const prev = byCod.get(cod);
    if (prev == null) { byCod.set(cod, u); continue; }
    dups.add(cod);
    if (desplaza(u, prev)) byCod.set(cod, u);
  }

  return { byCod, dupCods: [...dups].sort((a, b) => a - b) };
}
