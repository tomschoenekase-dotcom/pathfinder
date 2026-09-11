import { page } from './attention-pagination'

/** Adds independently bounded urgent rows without advancing past chronological rows not returned. */
export function mergePriorityEvents<T extends { id: string; createdAt: Date }>(
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
