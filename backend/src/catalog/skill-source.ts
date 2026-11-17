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

/** Página de listagem; `has_more` decide se o orquestrador pede a próxima. */
export interface CatalogPage {
  readonly items: SkillRecord[];
  readonly page: number;
  readonly has_more: boolean;
}

/** O que a fonte sabe entregar — lido antes de qualquer chamada, nunca inferido. */
export interface SkillSourceCapabilities {
  readonly supports_categories: boolean;
  readonly supports_documents: boolean;
}

/** Porta da fonte externa (skills.sh ou fixture). */
export interface SkillSource {
  readonly capabilities: SkillSourceCapabilities;
  listCategories(): Promise<CategoryRecord[]>;
  fetchCatalog(page: number): Promise<CatalogPage>;
  fetchDocument(sourceKey: string): Promise<DocumentRecord | null>;
}
