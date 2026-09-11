export class StateConflictError extends Error {
  constructor() {
    super('Între timp au fost salvate alte modificări. Această modificare nu a fost salvată. Reîncarcă pagina și încearcă din nou.');
    this.name = 'StateConflictError';
    this.code = 'STATE_CONFLICT';
    this.status = 409;
  }
}
