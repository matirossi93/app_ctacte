import { sb, TENANT_ID } from './supabase.js';
import { bloquearPresupuesto, desbloquearPresupuesto, invalidarAprobacion, ErrorVersion } from './versionPresupuesto.js';
import { invalidarIM } from './infomanager.js';

/** Pedido estable primero, PR actual después. Todos los escritores del vendedor comparten orden. */
export class ControlPedido {
  private locks: Array<{ id: string; token: string }> = [];
  conocido = true;
  intentoIM = false;
  constructor(private actividad: string) {}
  async tomar(pedido: any) {
    await this.bloquear(`pedido:${pedido.id}`);
    const { data: actual, error } = await sb().from('pedidos_vendedor').select('*').eq('tenant_id', TENANT_ID).eq('id', pedido.id).maybeSingle();
    if (error || !actual) throw new ErrorVersion('No pude releer el pedido antes de modificarlo.', 503);
    if (actual.estado !== pedido.estado || String(actual.im_presupuesto_id ?? '') !== String(pedido.im_presupuesto_id ?? '')) throw new ErrorVersion('El pedido cambió. Actualizá antes de continuar.');
    if (pedido.im_presupuesto_id) {
      await this.agregarPR(String(pedido.im_presupuesto_id));
      const { data: vinculo, error: e } = await sb().from('pedidos_vendedor').select('im_presupuesto_id, estado')
        .eq('tenant_id', TENANT_ID).eq('id', pedido.id).maybeSingle();
      if (e || !vinculo) throw new ErrorVersion('No pude verificar el vínculo actual del pedido.', 503);
      if (String(vinculo.im_presupuesto_id) !== String(pedido.im_presupuesto_id) || vinculo.estado !== pedido.estado) throw new ErrorVersion('La oficina modificó el pedido. Actualizá antes de continuar.');
    }
  }
  private async bloquear(id: string) {
    if (this.locks.some(x => x.id === id)) return;
    const token = await bloquearPresupuesto(id, this.actividad);
    this.locks.push({ id, token });
  }
  async agregarPR(id: string) {
    await this.bloquear(id);
    const { data, error } = await sb().from('presupuestos_facturados').select('im_factura_id, estado_emision')
      .eq('tenant_id', TENANT_ID).eq('im_comprobante_id', id).maybeSingle();
    if (error) throw new ErrorVersion('No pude verificar la facturación local del presupuesto.', 503);
    if (data) throw new ErrorVersion('El presupuesto tiene facturación registrada o pendiente de verificar. No se modificó InfoManager.');
  }
  async antesDeEscribir(pr?: string | number | null) {
    if (pr) await invalidarAprobacion(String(pr));
    this.conocido = false; this.intentoIM = true;
  }
  async cerrar() {
    if (this.intentoIM) {
      invalidarIM();
      const [{ invalidarVista }, { invalidarRemitos }] = await Promise.all([import('./vistaPresupuestos.js'), import('./vistaRemitos.js')]);
      invalidarVista(); invalidarRemitos();
    }
    if (this.conocido) for (const l of [...this.locks].reverse()) await desbloquearPresupuesto(l.id, l.token);
  }
}
export function comprobarIdentidadPedido(cab: any, pedido: any) {
  if (cab.existe === false || cab.anulada === true) return; // recuperación de comprobante realmente borrado/anulado
  if (cab.existe !== true || cab.anulada !== false || String(cab.tipo_comprobante ?? '').trim() !== 'PR' ||
      Number(cab.cod_empresa) !== Number(pedido.cod_empresa) || Number(cab.cod_cliente) !== Number(pedido.cod_cliente)) {
    throw new ErrorVersion('No pude verificar la identidad y vigencia del presupuesto del pedido. No se modificó InfoManager.');
  }
}
