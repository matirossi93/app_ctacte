import { LecturasCompartidas } from './lecturasCompartidas.js';
export const importesPuntuales = new LecturasCompartidas<any>(90_000, 500);
export function invalidarImportesFacturas() { importesPuntuales.invalidar(); }
