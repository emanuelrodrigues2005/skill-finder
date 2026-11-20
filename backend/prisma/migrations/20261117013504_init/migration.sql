-- Extensao necessaria para o operador de similaridade (fallback do FTS, 6.4).
-- Vai no topo: os indices GIN com gin_trgm_ops dependem dela.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- CreateEnum
CREATE TYPE "SecurityStatus" AS ENUM ('ok', 'warn', 'fail', 'unknown');

-- CreateEnum
CREATE TYPE "DocumentOrigin" AS ENUM ('skills_sh', 'github_raw');

-- CreateEnum
CREATE TYPE "IngestStatus" AS ENUM ('running', 'ok', 'partial', 'failed');

-- CreateEnum
CREATE TYPE "SearchStatus" AS ENUM ('ok', 'empty', 'degraded', 'error');

-- CreateEnum
CREATE TYPE "LlmCacheKind" AS ENUM ('intent', 'explanation');

-- CreateTable
CREATE TABLE "category" (
    "slug" TEXT NOT NULL,
    "label_en" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "seen_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "category_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "skill" (
    "id" BIGSERIAL NOT NULL,
    "source_key" TEXT NOT NULL,
    "source_url" TEXT,
    "slug" TEXT,
    "name" TEXT NOT NULL,
    "summary" TEXT,
    "repo_owner" TEXT,
    "repo_url" TEXT,
    "category_slug" TEXT,
    "stars" INTEGER,
    "installs" INTEGER,
    "vulnerability_count" INTEGER,
    "security_status" "SecurityStatus" NOT NULL DEFAULT 'unknown',
    "skill_md_present" BOOLEAN NOT NULL DEFAULT false,
    "search_doc" tsvector,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "raw" JSONB,

    CONSTRAINT "skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_metric_snapshot" (
    "skill_id" BIGINT NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL,
    "stars" INTEGER,
    "installs" INTEGER,
    "vulnerability_count" INTEGER,

    CONSTRAINT "skill_metric_snapshot_pkey" PRIMARY KEY ("skill_id","captured_at")
);

-- CreateTable
CREATE TABLE "skill_document" (
    "skill_id" BIGINT NOT NULL,
    "content" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "origin" "DocumentOrigin" NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL,
    "error" TEXT,

    CONSTRAINT "skill_document_pkey" PRIMARY KEY ("skill_id")
);

-- CreateTable
CREATE TABLE "ingest_run" (
    "id" BIGSERIAL NOT NULL,
    "adapter" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "status" "IngestStatus" NOT NULL,
    "items_seen" INTEGER,
    "items_upserted" INTEGER,
    "items_deactivated" INTEGER,
    "error_code" TEXT,
    "error_detail" TEXT,

    CONSTRAINT "ingest_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_request" (
    "id" UUID NOT NULL,
    "request_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "client_hash" TEXT NOT NULL,
    "query_hash" TEXT NOT NULL,
    "query_text" TEXT,
    "intent" JSONB,
    "category_slug" TEXT,
    "result_ids" BIGINT[],
    "candidates_count" INTEGER,
    "llm_status" TEXT,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "latency_ms" INTEGER,
    "status" "SearchStatus" NOT NULL,

    CONSTRAINT "search_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_cache" (
    "cache_key" TEXT NOT NULL,
    "kind" "LlmCacheKind" NOT NULL,
    "response" JSONB NOT NULL,
    "prompt_tokens" INTEGER,
    "completion_tokens" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "llm_cache_pkey" PRIMARY KEY ("cache_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "skill_source_key_key" ON "skill"("source_key");

-- CreateIndex
CREATE INDEX "skill_category_slug_is_active_idx" ON "skill"("category_slug", "is_active");

-- CreateIndex
CREATE INDEX "skill_stars_idx" ON "skill"("stars" DESC);

-- CreateIndex
CREATE INDEX "skill_installs_idx" ON "skill"("installs" DESC);

-- CreateIndex
CREATE INDEX "ingest_run_started_at_idx" ON "ingest_run"("started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "search_request_request_id_key" ON "search_request"("request_id");

-- CreateIndex
CREATE INDEX "search_request_created_at_idx" ON "search_request"("created_at" DESC);

-- CreateIndex
CREATE INDEX "search_request_query_hash_created_at_idx" ON "search_request"("query_hash", "created_at" DESC);

-- CreateIndex
CREATE INDEX "llm_cache_expires_at_idx" ON "llm_cache"("expires_at");

-- AddForeignKey
ALTER TABLE "skill" ADD CONSTRAINT "skill_category_slug_fkey" FOREIGN KEY ("category_slug") REFERENCES "category"("slug") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_metric_snapshot" ADD CONSTRAINT "skill_metric_snapshot_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_document" ADD CONSTRAINT "skill_document_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- DDL manual: o que o schema.prisma nao expressa (Unsupported / parcial).
-- Regenerar com prisma migrate dev --create-only NAO reproduz este bloco;
-- ver prisma/migrations/README.md e a sonda de drift.
-- ---------------------------------------------------------------------------

-- FTS da 6.4 (search_doc e Unsupported("tsvector") no PSL, nao gravavel pelo Client).
CREATE INDEX "skill_search_doc_idx" ON "skill" USING GIN ("search_doc");

-- Fallback de similaridade para typo ("kubernets" -> "kubernetes").
CREATE INDEX "skill_name_trgm_idx" ON "skill" USING GIN ("name" gin_trgm_ops);

-- Regra 3: ausente e NULL, nunca zero. Negativo em metrica e dado corrompido:
-- o banco recusa em vez de deixar o ranking pontuar lixo.
ALTER TABLE "skill" ADD CONSTRAINT "skill_stars_non_negative" CHECK ("stars" IS NULL OR "stars" >= 0);
ALTER TABLE "skill" ADD CONSTRAINT "skill_installs_non_negative" CHECK ("installs" IS NULL OR "installs" >= 0);
ALTER TABLE "skill" ADD CONSTRAINT "skill_vulnerability_count_non_negative" CHECK ("vulnerability_count" IS NULL OR "vulnerability_count" >= 0);

-- Lock da ingestao (7.3): no maximo UM run em 'running'. E o que sustenta o 409
-- do POST /admin/ingest; sem ele, dois runs simultaneos corrompem a contagem.
CREATE UNIQUE INDEX "ingest_run_running_key" ON "ingest_run" ("status") WHERE "status" = 'running';
