import { describe, it, expect } from 'vitest';
import { generarReciboPdf, type DatosRecibo } from './pdfRecibo';

/**
 * El recibo que el vendedor le deja al cliente.
 *
 * Mati (16/09/2026): *"un botón para poder compartir el recibo que crean ellos, para reemplazar
 * el recibo manual que actualmente están escribiendo los vendedores"*. O sea que este papel
 * ocupa el lugar del talonario: tiene que poder mostrarse solo, sin que nadie explique nada.
 */
const base: DatosRecibo = {
    numero: 30155202,
    cliente: 'MARQUEZ, Carolina (Lules)',
    cod_cliente: 470,
    fecha: '2026-09-16',
    monto: 597650,
    medio_pago: 'Efectivo',
    vendedor: 'Julio',
};

async function texto(d: DatosRecibo): Promise<string> {
    const { blob } = generarReciboPdf(d);
    return blob.text();
}

describe('el recibo que se le entrega al cliente', () => {
    it('🔴 entra en UNA sola hoja', async () => {
        const t = await texto(base);
        expect((t.match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(1);
    });

    it('🔴 lleva el importe EN LETRAS, que es lo que hace de un papel un recibo', async () => {
        const t = await texto(base);
        // El texto del PDF va partido en tokens; se busca una parte suficientemente rara.
        expect(t).toMatch(/quinientos noventa y siete mil/i);
    });

    it('🔴 dice quién recibió la plata: sin eso el cliente no sabe a quién reclamar', async () => {
        expect(await texto(base)).toMatch(/Julio/);
    });

    it('lleva el medio de pago y el cliente', async () => {
        const t = await texto(base);
        expect(t).toMatch(/Efectivo/);
        expect(t).toMatch(/MARQUEZ/);
    });

    it('🪤 sin número de InfoManager se aclara que es provisorio', async () => {
        // Mientras la oficina no lo imputó, el papel respalda que el vendedor recibió la plata,
        // no que la empresa la aplicó a la cuenta. Decirlo evita un reclamo por una imputación
        // que todavía no pasó.
        const t = await texto({ ...base, numero: null });
        expect(t.toLowerCase()).toMatch(/provisorio|constancia/);
    });

    it('el nombre del archivo sale limpio para Android y iOS', () => {
        const { nombre } = generarReciboPdf(base);
        expect(nombre).toBe('Recibo-30155202-MARQUEZ-Carolina-Lules.pdf');
        expect(nombre).not.toMatch(/[áéíóúñ,()]/);
    });

    it('con referencia y banco los muestra; sin ellos no deja el rótulo huérfano', async () => {
        const con = await texto({ ...base, medio_pago: 'Transferencia', banco_origen: 'Banco Nación', referencia: 'OP-99881' });
        expect(con).toMatch(/OP-99881/);
        expect(con).toMatch(/Naci/);
        const sin = await texto(base);
        expect(sin).not.toMatch(/OP-99881/);
    });
});
