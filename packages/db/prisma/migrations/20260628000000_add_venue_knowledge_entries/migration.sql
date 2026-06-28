-- Migration: venue knowledge entries
-- Adds the venue_knowledge_entries table with a pgvector embedding column for
-- semantic retrieval, mirroring the pattern used by places/005_place_embeddings.

CREATE TABLE "venue_knowledge_entries" (
  "id"         TEXT NOT NULL PRIMARY KEY,
  "tenant_id"  TEXT NOT NULL,
  "venue_id"   TEXT NOT NULL,
  "title"      TEXT NOT NULL,
  "category"   TEXT NOT NULL,
  "content"    TEXT NOT NULL,
  "is_enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "venue_knowledge_entries_venue_id_fkey"
    FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "venue_knowledge_entries_tenant_id_idx" ON "venue_knowledge_entries"("tenant_id");
CREATE INDEX "venue_knowledge_entries_venue_id_idx" ON "venue_knowledge_entries"("venue_id");

-- pgvector extension is already enabled by migration 005_place_embeddings.
-- Add the embedding column; nullable so existing rows are not blocked.
ALTER TABLE "venue_knowledge_entries" ADD COLUMN "embedding" vector(1536);

-- HNSW index for fast approximate nearest-neighbour search (cosine distance).
CREATE INDEX IF NOT EXISTS knowledge_embedding_hnsw_idx
  ON "venue_knowledge_entries"
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
