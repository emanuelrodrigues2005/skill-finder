/**
 * Porta do enriquecimento ao vivo — o `SearchService` depende **disto**, não do
 * `CatalogLiveEnricher`.
 *
 * A separação existe por dois motivos práticos:
 * - o serviço de busca não conhece `SkillSource` nem `CatalogRepository` (hoje ele
 *   fala com `SEARCH_CATALOG`); injetar a implementação concreta amarraria a busca
 *   ao módulo do catálogo;
 * - o teste injeta um duplo de três linhas e prova o comportamento (enriquece
 *   quando a lista veio vazia, não enriquece quando veio preenchida) sem tocar em
 *   rede nem em Postgres.
 */

/** Token de injeção. */
export const LIVE_ENRICHER = 'LIVE_ENRICHER';

export interface LiveEnrichInput {
  /** Termos em inglês da intenção (`keywords_en`, com queda para `keywords`). */
  readonly keywords: readonly string[];
  /** Teto de chaves desta rodada. */
  readonly limit?: number;
}

export interface LiveEnricher {
  /** `true` quando a configuração permite enriquecer. */
  readonly enabled: boolean;
  /**
   * Ingere as chaves do sitemap que casam com os termos.
   *
   * @returns quantas linhas foram gravadas; `0` quando nada casou, quando está
   *   desligado ou quando a fonte falhou. **Nunca lança**: o pior caso permitido é
   *   a resposta vazia que a busca já ia devolver.
   */
  enrich(input: LiveEnrichInput): Promise<number>;
}
