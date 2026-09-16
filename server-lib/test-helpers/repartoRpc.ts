/** Adaptador de respuestas para pruebas HTTP. No simula concurrencia: la cubre PostgreSQL. */
export function respuestaReparto(datosTablas: () => Record<string, any>, registrar: (tabla: string, op: string, valor: any, filtros: string[]) => void) {
  return async (_rpc: string, p: any) => {
    const d = p.p_datos, accion = p.p_accion;
    const tablas = datosTablas();
    // Vincular una nota existente tiene función propia: no lleva `p_accion`.
    if (_rpc === 'vincular_nota_existente') {
      const falla = tablas['hojas_ruta_ajustes']?.error;
      if (falla) return { data: null, error: falla };
      const fila = { id: 'aj1', ...p.p_ajuste, emitido_at: '2026-09-11' };
      registrar('hojas_ruta_ajustes', 'insert', fila, []);
      return { data: { ok: true, filas: fila, version: 2, factura: p.p_factura_esperada }, error: null };
    }
    const tabla = accion.startsWith('ajuste') ? 'hojas_ruta_ajustes' : accion.startsWith('retiro') ? 'retiros_sucursal' : ['asignar','quitar'].includes(accion) ? 'hojas_ruta_pedidos' : 'hojas_ruta';
    const falla = tablas[tabla]?.error;
    if (falla) return { data: null, error: { ...falla, message: falla.code === '23505' ? (accion==='hoja_crear' ? `Ya existe la hoja ${d.numero}` : 'La nota ya está vinculada') : falla.message } };
    if (accion === 'hoja_crear') { if (!d.numero) d.numero=Math.max((tablas[tabla]?.data?.numero ?? 0)+1,d.numero_minimo ?? 3405); registrar(tabla,'insert',d,[]); return { data: { id:'h1',version:1,...d }, error:null }; }
    if (accion === 'asignar' || accion === 'retiro_marcar') { registrar(tabla,'upsert',d.pedidos,[]); return { data:{filas:d.pedidos,version:2},error:null }; }
    if (accion === 'hoja_editar') {
      const cambios={...d.cambios,...(d.cambios.estado ? {cerrada_at:d.cambios.estado==='cerrada'?'2026-09-11':null}: {})};
      registrar(tabla,'update',cambios,[]); return {data:{...tablas[tabla]?.data,...cambios,version:2},error:null};
    }
    if (accion === 'ajuste_reclamar' || accion === 'ajuste_vincular') {
      const fila={id:'aj1',...d.ajuste,...(accion==='ajuste_vincular'?{emitido_at:'2026-09-11'}:{})};
      registrar(tabla,'insert',fila,[]); return {data:{filas:fila,version:2},error:null};
    }
    if (accion === 'ajuste_finalizar') {
      registrar(tabla,d.estado_operacion==='rechazado'?'delete':'update', d.estado_operacion==='rechazado'?null:{...d,...(d.estado_operacion==='completo'?{emitido_at:'2026-09-11'}:{})},[]);
      return {data:{ok:true},error:null};
    }
    if (['ajuste_borrar','retiro_quitar','quitar','hoja_borrar'].includes(accion)) {
      registrar(tabla,'delete',null,['eq:id,'+d.id]); return {data:{ok:true},error:null};
    }
    return {data:{ok:true},error:null};
  };
}
