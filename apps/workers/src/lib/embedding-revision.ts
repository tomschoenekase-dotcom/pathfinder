import { createHash } from 'node:crypto'

import { UnrecoverableError } from 'bullmq'

export function parseEmbeddingRevision(value: string): Date {
  const revision = new Date(value)
  if (Number.isNaN(revision.getTime()) || revision.toISOString() !== value) {
    throw new UnrecoverableError('Embedding contentUpdatedAt must be an ISO UTC timestamp')
  }
  return revision
}

export function embeddingRevisionMatches(actual: Date, expected: Date): boolean {
  return actual.getTime() === expected.getTime()
}

export function embeddingSourceHash(entityType: 'place' | 'knowledge-entry', text: string): string {
  return createHash('sha256')
    .update(`pathfinder:${entityType}:canonical-v1\0`, 'utf8')
    .update(text, 'utf8')
    .digest('hex')
}
