/**
 * Relógio injetável da borda temporal do orçamento (issue #35).
 *
 * A virada do dia é uma regra de calendário, e regra de calendário que lê
 * `new Date()` no meio do código não tem teste: provar o dia seguinte exigiria
 * esperar 24 h ou mexer no relógio da máquina. Quem lê as horas é este token;
 * produção usa {@link systemClock} e o teste injeta um relógio que avança.
 */
export interface Clock {
  now(): Date;
}

/** Token de injeção (string, como os de `search.tokens.ts`, para `useValue`). */
export const CLOCK = 'CLOCK';

/** Relógio do processo, em UTC — o default de produção. */
export const systemClock: Clock = {
  now: () => new Date(),
};
