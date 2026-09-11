import { describe, expect, it } from 'vitest'

import { mergePriorityEvents } from './attention-priority-events'

describe('attention priority event merge', () => {
  it('surfaces an independently selected urgent event while deferring routine rows by cursor', () => {
    const chronological = Array.from({ length: 11 }, (_, index) => ({
      id: `routine-${index}`,
      createdAt: new Date(Date.UTC(2026, 8, 7, 12, index)),
    })).reverse()
    const urgent = {
      id: 'urgent',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    }

    const result = mergePriorityEvents(chronological, [urgent], 10)

    expect(result.items[0]).toEqual(urgent)
    expect(result.items).toHaveLength(11)
    expect(result.nextCursor).toEqual({
      createdAt: chronological[9]!.createdAt.toISOString(),
      id: chronological[9]!.id,
    })
    expect(result.items.some((item) => item.id === chronological[10]!.id)).toBe(false)
  })

  it('deduplicates an urgent row already present in the chronological page', () => {
    const urgent = { id: 'urgent', createdAt: new Date('2026-09-07T12:00:00.000Z') }
    expect(mergePriorityEvents([urgent], [urgent], 10)).toEqual({
      items: [urgent],
      nextCursor: null,
    })
  })
})
