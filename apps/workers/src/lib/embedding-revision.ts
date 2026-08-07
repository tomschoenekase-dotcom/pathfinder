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
