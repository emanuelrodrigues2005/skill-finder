import { ApiProperty } from '@nestjs/swagger';

/** `CHECK (security_status IN (...))` de §4.1 — o catálogo só aceita estes quatro. */
export const SECURITY_STATUSES = ['ok', 'warn', 'fail', 'unknown'] as const;

export type SecurityStatus = (typeof SECURITY_STATUSES)[number];

/**
 * Payloads de leitura do catálogo (§5.4).
 *
 * Regra do projeto que aparece no schema: dado ausente é `null`, jamais zero.
 * `stars`, `installs` e `vulnerability_count` são nullable em toda skill; quem
 * marca o item incompleto é `evidence_completeness` (ver `ResultItem`).
 */

export class SkillSummary {
  @ApiProperty({ type: String, example: 'sk_01JCV8Y6Q4' })
  skill_id!: string;

  @ApiProperty({ type: String, example: 'python-security-review' })
  name!: string;

  @ApiProperty({
    type: String,
    format: 'uri',
    nullable: true,
    description: 'Absolute https URL from the catalog. Reject any other scheme.',
  })
  source_url!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'backend',
    description:
      'Category slug. null until ingestion classifies the skill (the column has no NOT NULL).',
  })
  category!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, description: 'null when the source omits it.' })
  stars!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, description: 'null when the source omits it.' })
  installs!: number | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'null when the vulnerability scan has not run for this skill.',
  })
  vulnerability_count!: number | null;

  @ApiProperty({
    enum: [...SECURITY_STATUSES],
    example: 'ok',
    description: 'Security verdict of the last scan; the only values the catalog column accepts.',
  })
  security_status!: SecurityStatus;

  @ApiProperty({ type: Boolean, description: 'Whether the catalog stored a `SKILL.md` for it.' })
  skill_md_present!: boolean;
}

/** Detalhe de `GET /api/v1/skills/{skill_id}` (§5.4). */
export class SkillDetail extends SkillSummary {
  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: 280,
    description:
      'One-paragraph summary; null if absent. Plain text from an untrusted source. Render escaped; never as HTML or markdown. Ingestion truncates to 280 characters, so the client never receives more.',
  })
  summary!: string | null;

  @ApiProperty({
    type: String,
    format: 'uri',
    nullable: true,
    description: 'Absolute https URL from the catalog. Reject any other scheme.',
  })
  repo_url!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: 600,
    description:
      'Excerpt of `SKILL.md` (≤ 600 characters, no raw markdown); null if absent. Plain text from an untrusted source. Render escaped; never as HTML or markdown.',
  })
  skill_md_excerpt!: string | null;
}

/** Bloco `pagination` de toda listagem (§5.6). */
export class Pagination {
  @ApiProperty({ type: 'integer', minimum: 1, description: '1-based page.' })
  page!: number;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 100, description: 'Items per page.' })
  page_size!: number;

  @ApiProperty({ type: 'integer', minimum: 0, description: 'Total items matching the filters.' })
  total_items!: number;

  @ApiProperty({ type: 'integer', minimum: 0, description: 'Total pages for this page size.' })
  total_pages!: number;
}

export class CategoryItem {
  @ApiProperty({ type: String, example: 'backend' })
  slug!: string;

  @ApiProperty({ type: String, example: 'Backend' })
  label_en!: string;

  @ApiProperty({ type: 'integer', minimum: 0, description: 'Skills currently in this category.' })
  skill_count!: number;
}

/** `GET /api/v1/categories` → `200` (§5.4). */
export class CategoryListResponse {
  @ApiProperty({ type: String, description: 'Request id echo (`X-Request-Id`).' })
  request_id!: string;

  @ApiProperty({ type: [CategoryItem] })
  data!: CategoryItem[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Catalog snapshot the list came from.',
  })
  data_snapshot!: string;
}

/** `GET /api/v1/skills` → `200` (§5.4). */
export class SkillListResponse {
  @ApiProperty({ type: String, description: 'Request id echo (`X-Request-Id`).' })
  request_id!: string;

  @ApiProperty({ type: [SkillSummary] })
  data!: SkillSummary[];

  @ApiProperty({ type: () => Pagination })
  pagination!: Pagination;
}

/** `GET /api/v1/skills/{skill_id}` → `200` (§5.4). */
export class SkillDetailResponse {
  @ApiProperty({ type: String, description: 'Request id echo (`X-Request-Id`).' })
  request_id!: string;

  @ApiProperty({ type: () => SkillDetail })
  data!: SkillDetail;
}
