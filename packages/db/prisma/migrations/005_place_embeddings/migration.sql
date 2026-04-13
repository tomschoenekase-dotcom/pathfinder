-- Migration 005: place embeddings (pgvector)
-- Enables the pgvector extension and adds an embedding column to places.
-- The embedding is populated asynchronously after create/update via the API layer.

-- Enable pgvector (no-op if already enabled on Supabase)
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column — nullable so existing rows are not blocked
ALTER TABLE places ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- HNSW index for fast approximate nearest-neighbour search using cosine distance.
-- Cosine similarity is appropriate for normalised text embeddings from OpenAI.
CREATE INDEX IF NOT EXISTS places_embedding_hnsw_idx
  ON places
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
