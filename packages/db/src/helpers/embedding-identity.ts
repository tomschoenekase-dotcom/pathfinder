import { createHash } from 'node:crypto'

export type EmbeddingSourceEntity = 'place' | 'knowledge-entry' | 'company-knowledge'

export function embeddingSourceHash(entityType: EmbeddingSourceEntity, text: string): string {
  return createHash('sha256')
    .update(`pathfinder:${entityType}:canonical-v1\0`, 'utf8')
    .update(text, 'utf8')
    .digest('hex')
}
