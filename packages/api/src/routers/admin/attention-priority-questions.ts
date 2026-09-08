import type { Prisma } from '@prisma/client'

import { page } from './attention-pagination'

export const attentionQuestionSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  agentRunId: true,
  question: true,
  context: true,
  questionType: true,
  category: true,
  urgency: true,
  choices: true,
  dueAt: true,
  expiresAt: true,
  evidence: true,
  proposedAnswer: true,
  blocking: true,
  createdAt: true,
  updatedAt: true,
  venue: { select: { name: true } },
  agentIdentity: { select: { name: true } },
  agentRun: { select: { id: true, status: true, requestedOperation: true } },
} satisfies Prisma.AgentQuestionSelect

export function mergePriorityQuestions<T extends { id: string; createdAt: Date }>(
  chronologicalRows: T[],
  priorityRows: T[],
  limit: number,
) {
  const chronologicalPage = page(chronologicalRows, limit)
  const items = new Map<string, T>()
  for (const item of page(priorityRows, limit).items) items.set(item.id, item)
  for (const item of chronologicalPage.items) items.set(item.id, item)
  return { items: [...items.values()], nextCursor: chronologicalPage.nextCursor }
}
