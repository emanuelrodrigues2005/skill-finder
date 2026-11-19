/**
 * Enriquecimento ao vivo do catálogo (#46/#47, pedido do dono).
 *
 * O catálogo é local: a ingestão enche a tabela `skill` e a busca lê um FTS no
 * Postgres. Isso é rápido e determinístico, mas tem um intervalo — entre ciclos,
 * uma skill publicada agora ainda não está no banco.
 *
 * Esta peça cobre esse intervalo **sem virar busca remota por consulta**. Ela não
 * chama o site a cada busca: só entra quando a busca local **não devolveu nada**, e
 * mesmo então o trabalho é limitado — enumera o sitemap (2 requisições, cache de
 * 6 h no adaptador), filtra as chaves pelo `slug` e busca o detalhe de no máximo
 * `limit` delas, a 1 req/s. O resultado é **ingerido**, não devolvido direto: a
 * próxima busca (e a re-execução imediata) encontram as linhas no banco, com o
 * ranking e a explicação de sempre.
 *
 * Por que não "raspar a busca do site": `robots.txt` do skills.sh proíbe
 * `/search` e `/api/` para crawler. Sitemap e página de detalhe são permitidos —
 * é o que esta peça usa.
 */
import { Injectable, Logger } from "@nestjs/common";

import type { SkillSource } from "./skill-source";
import type { CatalogRepository } from "./catalog-repository";
import { ingest } from "./ingest";
import type { AppConfigService } from "../config/config.module";

/** Limite de chaves por enriquecimento. Cada chave é 1 requisição a 1 req/s. */
export const DEFAULT_LIVE_ENRICH_MAX_KEYS = 12;

/** Tamanho mínimo de um termo para ele casar por `slug` (evita "de", "a", "of"). */
const MIN_TERM = 3;

/**
 * Normaliza o `slug` de uma chave (`owner/repo/slug`) e devolve os tokens.
 *
 * A chave é `owner/repo/slug`; o `slug` é a parte descritiva publicada
 * (`anthropics/skills/webapp-testing` → `webapp`, `testing`). `repo` também entra
 * porque às vezes é ele que diz o assunto (`vercel-labs/skills/find-skills`).
 */
export function slugTerms(sourceKey: string): string[] {
  const partes = sourceKey.toLowerCase().split("/");
  const descritivo = partes.length >= 3 ? `${partes[1]} ${partes[2]}` : partes.join(" ");
  return descritivo
    .split(/[^a-z0-9]+/u)
    .filter((termo) => termo.length >= MIN_TERM);
}

/**
 * Chaves cujo `slug` casa com algum termo. Função **pura**: a ordem de entrada é
 * preservada (o sitemap é estável) e o corte é do chamador.
 *
 * Casa por prefixo nos dois sentidos (`test`/`testing`, `develop`/`developer`),
 * porque a intenção vem em inglês mas o slug é escrito por quem publica.
 */
export function matchKeysBySlug(
  sourceKeys: readonly string[],
  keywords: readonly string[],
): string[] {
  const termos = [
    ...new Set(
      keywords
        .flatMap((keyword) => keyword.toLowerCase().split(/[^a-z0-9]+/u))
        .filter((termo) => termo.length >= MIN_TERM),
    ),
  ];
  if (termos.length === 0) {
    return [];
  }
  return sourceKeys.filter((sourceKey) => {
    const doSlug = slugTerms(sourceKey);
    return termos.some((termo) =>
      doSlug.some((token) => token.startsWith(termo) || termo.startsWith(token)),
    );
  });
}

/** O que a busca precisa do enriquecimento. */
export interface LiveEnrichRequest {
  /** Termos em inglês da intenção; vazio desliga o enriquecimento. */
  readonly keywords: readonly string[];
  /** Teto de chaves desta rodada. */
  readonly limit?: number;
}

/**
 * Chamado **pelo serviço de busca**, nunca pelo controller: é a busca que decide
 * se o catálogo local foi insuficiente.
 */
@Injectable()
export class CatalogLiveEnricher {
  private readonly logger = new Logger(CatalogLiveEnricher.name);

  constructor(
    private readonly source: SkillSource,
    private readonly repository: CatalogRepository,
    private readonly config: AppConfigService,
  ) {}

  /** `true` quando a configuração permite enriquecer. */
  get enabled(): boolean {
    return this.config.env.liveEnrichEnabled;
  }

  /**
   * Ingere até `limit` chaves que casam com as palavras-chave.
   *
   * @returns quantas linhas foram gravadas; `0` quando nada casou, quando está
   *   desligado ou quando a fonte falhou (falha aqui **não** derruba a busca: o
   *   pior caso é a resposta vazia que já existia).
   */
  async enrich(request: LiveEnrichRequest): Promise<number> {
    if (!this.enabled) {
      return 0;
    }
    const limit = Math.max(0, request.limit ?? DEFAULT_LIVE_ENRICH_MAX_KEYS);
    if (limit === 0 || request.keywords.length === 0) {
      return 0;
    }

    try {
      const todas = await this.source.listKeys();
      const casadas = matchKeysBySlug(todas, request.keywords).slice(0, limit);
      if (casadas.length === 0) {
        // Diagnóstico sem dado do usuário: só quantas chaves o sitemap tinha.
        this.logger.debug(
          `enriquecimento ao vivo: nenhuma chave casou (sitemap com ${String(todas.length)} chaves)`,
        );
        return 0;
      }
      // `keys` explícitas: a execução abre run próprio e pede exatamente estas
      // chaves — não gira o rodízio nem gasta a cota de descoberta.
      const outcome = await ingest({
        source: this.source,
        repository: this.repository,
        adapter: this.config.env.skillSourceKind,
        startedAt: new Date(),
        keys: casadas,
      });
      return outcome.items_upserted;
    } catch (error) {
      // Fonte fora do ar, sitemap mudado, run concorrente: a busca segue com o
      // catálogo local. O log é a única testemunha — por isso não é silencioso.
      this.logger.warn(
        `enriquecimento ao vivo falhou: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }
}
