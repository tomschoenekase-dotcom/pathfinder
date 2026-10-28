// Compatibility path for the CLI and background dispatcher.
export {
  auditEmbeddingFreshness,
  classifyEmbeddingFreshness,
  ACTIONABLE_EMBEDDING_FRESHNESS_REASONS,
  EMBEDDING_FRESHNESS_PAGE_SIZE,
  EMBEDDING_FRESHNESS_SCAN_CAP,
  type EmbeddingFreshnessCandidate,
  type EmbeddingFreshnessReason,
  type EmbeddingFreshnessAudit,
  type ActionableEmbeddingFreshnessReason,
} from '@pathfinder/db'
