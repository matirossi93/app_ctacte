import { describe, it, expect } from 'vitest';
import { puedeVerPanelOficina, pidePanelOficina, filtraPorVendedor } from './panelOficina';

describe('puedeVerPanelOficina', () => {
    it('entran admin, gerente y administrativo', () => {
        for (const rol of ['admin', 'gerente', 'administrativo']) {
            expect(puedeVerPanelOficina(rol)).toBe(true);
        }
    });

    it('🔴 no entran vendedor, repartidor, socio ni encargado', () => {
        // Un vendedor vería y podría mover los pedidos de todo el equipo.
        for (const rol of ['vendedor', 'repartidor', 'socio', 'encargado', '', null, undefined]) {
            expect(puedeVerPanelOficina(rol as any)).toBe(false);
        }
    });
});

describe('pidePanelOficina', () => {
    it('reconoce /reparto y lo que cuelga de ahí', () => {
        for (const p of ['/reparto', '/reparto/', '/reparto/hojas']) {
            expect(pidePanelOficina(p)).toBe(true);
        }
    });

    it('🔴 NO confunde /repartidor con /reparto', () => {
        // 🪤 Un `startsWith('/reparto')` a secas se lleva puesto al repartidor, que tiene su
        // propio shell: entraría al panel de la oficina y no podría cargar sus recibos.
        expect(pidePanelOficina('/repartidor')).toBe(false);
        expect(pidePanelOficina('/repartidores')).toBe(false);
    });

    it('la raíz y las demás rutas no son el panel', () => {
        for (const p of ['/', '', '/pedidos', '/cobranzas']) {
            expect(pidePanelOficina(p)).toBe(false);
        }
    });
});

describe('filtraPorVendedor — el selector de vendedores del panel', () => {
    // 🔴 26/09: Anto (administrativo) veía la cartera de todos pero sin poder elegir vendedor.
    it('la oficina elige vendedor: admin, gerente y administrativo', () => {
        for (const rol of ['admin', 'gerente', 'administrativo']) expect(filtraPorVendedor(rol), rol).toBe(true);
    });
    it('el resto no: el vendedor ve lo suyo y los demás roles no tienen selector', () => {
        for (const rol of ['vendedor', 'socio', 'encargado', 'repartidor', '', null, undefined]) {
            expect(filtraPorVendedor(rol as any), String(rol)).toBe(false);
        }
    });
});
