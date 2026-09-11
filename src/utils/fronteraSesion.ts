/** Contexto de una pantalla autenticada; jamás usar el token como clave persistida. */
export class FronteraSesion {
  private token: string | null;
  private email: string | null;
  constructor(token: string | null, email: string | null) { this.token = token; this.email = email; }
  coincide(token: string | null, email: string | null) { return token === this.token && email === this.email; }
}
