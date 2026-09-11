let revisionEscrituras = 0;
export function invalidarLecturasReparto() { revisionEscrituras++; }
/** Una generación por recurso. Abort no basta: también se descartan respuestas ya resueltas. */
export class LecturaVigente {
  private secuencia = 0;
  private controller: AbortController | null = null;
  private ultima: { clave: string; at: number; revision: number } | null = null;
  invalidar() { ++this.secuencia; this.controller?.abort(); this.controller = null; }
  caducar() { this.ultima = null; this.invalidar(); }
  iniciar(clave: string, vigente: () => boolean, forzar = false) {
    if (!forzar && this.ultima?.clave === clave && this.ultima.revision === revisionEscrituras && Date.now() - this.ultima.at < 30_000) return null;
    // Al empezar otra carga, la vista puede vaciar su resultado. Su última respuesta
    // deja de ser reutilizable incluso si vuelve a la misma clave antes de terminar.
    this.ultima = null;
    const revision = revisionEscrituras;
    this.invalidar(); const secuencia = this.secuencia; const controller = new AbortController(); this.controller = controller;
    const actual = () => secuencia === this.secuencia && !controller.signal.aborted && vigente();
    return { signal: controller.signal, vigente: actual, confirmar: () => { if (actual()) this.ultima = { clave, at: Date.now(), revision }; } };
  }
}
export function seleccionVisible(ids: string[], seleccion: Set<string>) {
  const cantidad = ids.filter(id => seleccion.has(id)).length;
  return { todos: ids.length > 0 && cantidad === ids.length, parcial: cantidad > 0 && cantidad < ids.length, ocultos: [...seleccion].filter(id => !ids.includes(id)).length };
}
export function alternarVisibles(ids: string[], seleccion: Set<string>) {
  const quitar = seleccionVisible(ids, seleccion).todos, siguiente = new Set(seleccion);
  for (const id of ids) { if (quitar) siguiente.delete(id); else siguiente.add(id); }
  return siguiente;
}
