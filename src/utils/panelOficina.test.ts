import { describe, it, expect } from 'vitest';
import { puedeVerPanelOficina, pidePanelOficina } from './panelOficina';

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
