/**
 * Porta de entrada do catálogo (`docs/app/02-arquitetura.md` §7.1).
 *
 * `SkillRecord` já é o formato **interno**, não o formato do site: toda a
 * normalização vive no adaptador (é o único lugar que conhece o skills.sh). Os
 * nomes dos campos são os das colunas de `prisma/schema.prisma` porque o
 * repositório grava direto o que chega aqui — nenhuma camada inventa campo.
 *
 * Regra 3 do `AGENTS.md`: dado ausente é `null`, jamais `0`. Por isso todo campo
 * opcional é anulável e `vulnerability_count` é sempre `null` (decisão D3: a
 * fonte não publica o número; ver `docs/app/amostras/README.md`).
 */

/** Estado de segurança como o banco o conhece (`enum SecurityStatus`). */
export type SecurityStatus = 'ok' | 'warn' | 'fail' | 'unknown';

/** Uma skill no formato interno do catálogo. */
export interface SkillRecord {
  /** `owner/repo/slug`, 3 segmentos do path, lowercase, sem query nem fragmento. */
  readonly source_key: string;
  /** URL `https://` da página de detalhe; `null` quando a origem não é https. */
  readonly source_url: string | null;
  /** Título antes do em dash (`find-skills`), nunca vazio. */
  readonly name: string;
  /** Resumo truncado em 280, corte puro. */
  readonly summary: string | null;
  readonly category_slug: string | null;
  readonly stars: number | null;
  readonly installs: number | null;
  /** Sempre `null`: o skills.sh não publica contagem de vulnerabilidades (D3). */
  readonly vulnerability_count: number | null;
  readonly security_status: SecurityStatus;
  /** Sempre `null`: a fonte não dá a URL do repositório — não sintetizar. */
  readonly repo_url: string | null;
  readonly skill_md_present: boolean;
  /** Primeira vez que a skill apareceu na fonte, já convertida; `null` se ilegível. */
  readonly first_seen_at: Date | null;
  /** Linha crua congelada em `skill.raw`, para auditoria. */
  readonly raw: unknown;
}

/** Categoria como a fonte a lista (§7.1). A fonte `fixture` não tem nenhuma. */
export interface CategoryRecord {
  readonly slug: string;
  readonly label_en: string;
  readonly position: number;
}

/** `SKILL.md` de uma skill, já recortado para prompt/armazenamento (§7.5). */
export interface DocumentRecord {
  readonly source_key: string;
  /** Trecho truncado em 600, corte puro; `null` quando o documento está vazio. */
  readonly skill_md_excerpt: string | null;
}

/** O que a fonte sabe entregar — lido antes de qualquer chamada, nunca inferido. */
export interface SkillSourceCapabilities {
  readonly supports_categories: boolean;
  readonly supports_documents: boolean;
}

/**
 * Porta da fonte externa (skills.sh ou fixture).
 *
 * **A fonte não pagina** (#46): não existe listagem paginada, não há
 * `pagination_style` e a aquisição é sempre por chave. O que há é a enumeração
 * de chaves (`listKeys`) e o detalhe por chave (`fetchSkills`).
 */
export interface SkillSource {
  readonly capabilities: SkillSourceCapabilities;
  listCategories(): Promise<CategoryRecord[]>;
  /**
   * Skills conhecidas para as chaves pedidas, na ordem pedida — a unidade do
   * rodízio (§7.3), que escolhe até 720 `source_key` por ciclo e pede
   * exatamente essas. O skills.sh não publica listagem paginada (só sitemap +
   * página de detalhe), então a chave é a única unidade honesta de aquisição.
   *
   * Contrato: devolve **só** as chaves conhecidas, com a repetida aparecendo
   * uma vez (na primeira posição pedida). Chave desconhecida é ausência, não
   * erro: é omitida e **nunca lança** por causa dela — uma chave que sumiu da
   * fonte, ou que veio corrompida, não pode derrubar o ciclo de ingestão.
   */
  fetchSkills(keys: readonly string[]): Promise<SkillRecord[]>;
  /**
   * As chaves que a fonte conhece, para o **primeiro** ciclo (§7.3): com o
   * catálogo vazio não há linha para o rodízio selecionar, e sem enumeração o
   * rodízio nunca começaria. É a única leitura que não vem de `source_key`
   * conhecido — por isso ela não entrega registros, só chaves: quem busca o
   * detalhe continua sendo `fetchSkills(keys)`, respeitando o limitador.
   *
   * Enumeração, não paginação: o adaptador `html` devolve as chaves do
   * `sitemap.xml`, e o chamador corta no teto do ciclo (`CYCLE_SLOTS`). Pode
   * lançar — sitemap fora do ar é falha do run, não "catálogo vazio".
   */
  listKeys(): Promise<string[]>;
  fetchDocument(sourceKey: string): Promise<DocumentRecord | null>;
}
