ALTER TYPE "EmbeddingWorkEntityType" ADD VALUE IF NOT EXISTS 'COMPANY_KNOWLEDGE';

ALTER TABLE company_knowledge_items
  ADD COLUMN embedding vector(1536),
  ADD COLUMN embedding_source_hash CHAR(64),
  ADD COLUMN embedding_profile VARCHAR(191),
  ADD COLUMN embedded_at TIMESTAMP(3);

CREATE INDEX company_knowledge_embedding_hnsw_idx
  ON company_knowledge_items
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
