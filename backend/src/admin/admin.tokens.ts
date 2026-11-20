/**
 * Token de injeção da porta de leitura do histórico de `ingest_run` (#49).
 *
 * Mora num arquivo próprio para o controller e o módulo importarem o mesmo
 * símbolo sem ciclo (`admin.module.ts` importa o controller).
 */
export const INGEST_RUN_LOG = 'INGEST_RUN_LOG';
