import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { prepareGuestQueryEvidence } from './guest-query-evidence'
import type { GuestQuerySource } from './guest-query-source'
import { prepareGuestStructuredSnapshot } from './guest-structured-query'

function source(): GuestQuerySource {
  return {
    tenantId: 'tenant-test',
    venueId: 'venue-test',
    version: 'v1',
    asOf: '2026-10-21T05:00:00.000Z',
    coverage: 'COMPLETE',
    readPath: 'LEGACY',
    includeSecondLayer: false,
    directory: {
      incomplete: false,
      searchVersion: 'v1',
      places: [
        {
          id: 'same',
          name: 'Moon Ride',
          type: 'ATTRACTION',
          itemType: 'PLACE',
          shortDescription: 'Moon Ride has conditional entry.',
          longDescription:
            'Height at least 48 inches; ages 8 and up. Under 10 with a paying adult. Closed October 20–22; booking does not waive restrictions. Service dogs cannot ride.',
          lat: null,
          lng: null,
          tags: ['family'],
          areaName: 'North',
          hours: null,
          photoUrl: null,
          sourceType: 'MANUAL',
          sourceName: null,
          sourceUrl: null,
        },
      ],
      knowledge: [
        {
          id: 'same',
          title: 'Moon Ride booking',
          category: 'VISIT',
          content:
            'Bookings are free but each rider pays $8. Weekends only. Never waive age or height conditions.',
          sourceType: 'MANUAL',
          sourceName: null,
          sourceUrl: null,
        },
      ],
    },
  }
}
const rawPlan = JSON.stringify({
  status: 'QUERY',
  mode: 'list',
  predicates: [{ field: 'kind', equals: 'ATTRACTION' }],
})
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

describe('guest query evidence orchestration', () => {
  it('performs exactly one evaluation for QUERY and none for UNSUPPORTED', async () => {
    const exemplar = prepareGuestStructuredSnapshot({
      tenantId: 't',
      venueId: 'v',
      version: '1',
      asOf: '2026-10-21T05:00:00.000Z',
      coverage: 'COMPLETE',
      records: [],
    })
    const evaluate = vi.spyOn(Object.getPrototypeOf(exemplar), 'evaluate')
    try {
      const ready = await prepareGuestQueryEvidence({
        source: source(),
        question: 'List rides',
        interpret: async () => rawPlan,
      })
      expect(ready.status).toBe('READY')
      expect(evaluate).toHaveBeenCalledOnce()
      evaluate.mockClear()
      const unsupported = await prepareGuestQueryEvidence({
        source: source(),
        question: 'Which ride at my height?',
        interpret: async () => '{"status":"UNSUPPORTED","reason":"Height condition"}',
      })
      expect(unsupported.status).toBe('UNSUPPORTED')
      expect(evaluate).not.toHaveBeenCalled()
    } finally {
      evaluate.mockRestore()
    }
  })
  it('uses one interpreter call, authorized scope and pinned question/prompt trace', async () => {
    const input = source()
    const before = structuredClone(input)
    const interpret = vi.fn(async (request: { system: string; question: string }) => {
      expect(request.system).toContain('read-only query')
      return rawPlan
    })
    const output = await prepareGuestQueryEvidence({
      source: input,
      question: 'Which attractions?',
      interpret,
    })
    expect(interpret).toHaveBeenCalledOnce()
    const request = interpret.mock.calls[0]![0]
    expect(Object.keys(request).sort()).toEqual(['question', 'system'])
    expect(request.question).toBe('Which attractions?')
    expect(output.trace).toMatchObject({
      sourceVersion: 'v1',
      questionSha256: sha('Which attractions?'),
      plannerPromptSha256: sha(request.system),
      rawPlan,
    })
    expect(output.status).toBe('READY')
    if (output.status !== 'READY') throw new Error('expected READY')
    expect(output.trace.plan).toMatchObject({
      status: 'QUERY',
      query: { tenantId: 'tenant-test', venueId: 'venue-test' },
    })
    expect(output.result).toMatchObject({
      knownMatchCount: 1,
      unknownCandidateCount: 0,
      exactEligibleCount: 1,
    })
    expect(output.result.matchingKeys).toEqual(['place:same'])
    expect(input).toEqual(before)
  })

  it('renders the whole original row with all conditions, not a synthesized description', async () => {
    const input = source()
    const output = await prepareGuestQueryEvidence({
      source: input,
      question: 'List rides',
      interpret: async () => rawPlan,
    })
    if (output.status !== 'READY') throw new Error('expected READY')
    const data = JSON.parse(
      output.evidence.prompt.slice(output.evidence.prompt.lastIndexOf('\n') + 1),
    )
    expect(JSON.parse(data.rows[0].sourceText)).toEqual(input.directory.places[0])
    expect(data.rows[0].sourceText).toContain('Under 10 with a paying adult')
    expect(data.rows[0].sourceText).toContain('booking does not waive restrictions')
    expect(data.rows[0].sourceText).toContain('Service dogs cannot ride')
    expect(output.evidence.includedKeys).toEqual(['place:same'])
    expect(output.evidence.omittedKeys).toEqual([])
    expect(JSON.parse(data.context[0].text)).toEqual(input.directory.knowledge[0])
    expect(data.context[0].text).toContain('Bookings are free but each rider pays $8')
    expect(data.context[0].text).toContain('Never waive age or height conditions')
    expect(output.evidence.includedContextKeys).toEqual(['knowledge:same'])
    expect(output.evidence.completeContext).toBe(true)
  })

  it('preserves an unrelated knowledge topic as scoped context, not a proven association', async () => {
    const input = source()
    input.directory.knowledge.push({
      ...input.directory.knowledge[0]!,
      id: 'theater',
      title: 'Theater ticketing only',
      content: 'Lantern Theater only: no late entry. Does not apply to rides.',
    })
    const output = await prepareGuestQueryEvidence({
      source: input,
      question: 'List rides',
      interpret: async () => rawPlan,
    })
    if (output.status !== 'READY') throw new Error('expected READY')
    expect(output.result.matchingKeys).toEqual(['place:same'])
    const data = JSON.parse(
      output.evidence.prompt.slice(output.evidence.prompt.lastIndexOf('\n') + 1),
    )
    expect(data.context.map((row: { key: string }) => row.key)).toEqual([
      'knowledge:same',
      'knowledge:theater',
    ])
    expect(JSON.parse(data.context[1].text).content).toBe(
      'Lantern Theater only: no late entry. Does not apply to rides.',
    )
    expect(output.evidence.prompt).toContain('Do not assume every topic applies to every result')
  })

  it('keeps large knowledge context whole or explicitly omitted under the 30,000-character body budget', async () => {
    const input = source()
    input.directory.knowledge[0]!.content = `POLICY-BEGIN${'condition;'.repeat(4000)}POLICY-END`
    const output = await prepareGuestQueryEvidence({
      source: input,
      question: 'List rides',
      interpret: async () => rawPlan,
    })
    if (output.status !== 'READY') throw new Error('expected READY')
    expect(output.evidence.prompt.length).toBeLessThanOrEqual(30_000)
    expect(output.evidence.completePage).toBe(true)
    expect(output.evidence.completeContext).toBe(false)
    expect(output.evidence.omittedContextKeys).toEqual(['knowledge:same'])
    expect(output.evidence.prompt).not.toContain('POLICY-BEGIN')
    expect(output.evidence.prompt).not.toContain('POLICY-END')
    const data = JSON.parse(
      output.evidence.prompt.slice(output.evidence.prompt.lastIndexOf('\n') + 1),
    )
    expect(data.omittedContextCount).toBe(1)
  })

  it('continues 51 matching rows as 50 plus one at a later observation time without duplicate IDs', async () => {
    const input = source()
    input.directory.places = Array.from({ length: 51 }, (_, i) => ({
      ...input.directory.places[0]!,
      id: String(i).padStart(3, '0'),
      name: `Ride ${i}`,
    }))
    const interpret = vi.fn(async () => rawPlan)
    const first = await prepareGuestQueryEvidence({
      source: input,
      question: 'List rides',
      interpret,
    })
    if (first.status !== 'READY') throw new Error('expected READY')
    expect(first.result).toMatchObject({ knownMatchCount: 51, returnedCount: 50, hasMore: true })
    const cursor = first.result.nextCursor!
    const second = await prepareGuestQueryEvidence({
      source: { ...input, asOf: '2026-10-21T06:00:00.000Z' },
      question: 'List rides',
      page: { cursor },
      interpret,
    })
    if (second.status !== 'READY') throw new Error('expected READY')
    expect(second.result).toMatchObject({
      knownMatchCount: 51,
      returnedCount: 1,
      hasMore: false,
      nextCursor: null,
    })
    expect(new Set([...first.result.rows, ...second.result.rows].map((row) => row.key)).size).toBe(
      51,
    )
    expect(interpret).toHaveBeenCalledTimes(2)
  })

  it('rejects continuation after typed source content or source version changes', async () => {
    const input = source()
    input.directory.places.push({
      ...input.directory.places[0]!,
      id: 'second',
      name: 'Second Ride',
    })
    const first = await prepareGuestQueryEvidence({
      source: input,
      question: 'List rides',
      page: { pageSize: 1 },
      interpret: async () => rawPlan,
    })
    if (first.status !== 'READY') throw new Error('expected READY')
    const cursor = first.result.nextCursor!
    const changed = structuredClone(input)
    changed.directory.places[0]!.name = 'Changed Ride Name'
    await expect(
      prepareGuestQueryEvidence({
        source: changed,
        question: 'List rides',
        page: { cursor },
        interpret: async () => rawPlan,
      }),
    ).rejects.toThrow(/changed/)
    const updated = {
      ...input,
      version: 'v2',
      directory: { ...input.directory, searchVersion: 'v2' },
    }
    await expect(
      prepareGuestQueryEvidence({
        source: updated,
        question: 'List rides',
        page: { cursor },
        interpret: async () => rawPlan,
      }),
    ).rejects.toThrow(/changed/)
  })

  it('clones pagination before callback and rejects explicit invalid page bounds', async () => {
    const input = source()
    input.directory.places.push({
      ...input.directory.places[0]!,
      id: 'second',
      name: 'Second Ride',
    })
    const page = { pageSize: 1 }
    const output = await prepareGuestQueryEvidence({
      source: input,
      question: 'List rides',
      page,
      interpret: async () => {
        page.pageSize = 201
        return rawPlan
      },
    })
    if (output.status !== 'READY') throw new Error('expected READY')
    expect(output.result.returnedCount).toBe(1)
    for (const pageSize of [0, -1, 201, 1.5, NaN, Infinity]) {
      await expect(
        prepareGuestQueryEvidence({
          source: source(),
          question: 'List rides',
          page: { pageSize },
          interpret: async () => rawPlan,
        }),
      ).rejects.toThrow(/bound/)
    }
  })

  it('cannot have source identity, membership or bodies changed by callback mutation of the original', async () => {
    const input = source()
    const originalBody = input.directory.places[0]!.longDescription
    const output = await prepareGuestQueryEvidence({
      source: input,
      question: 'List rides',
      interpret: async () => {
        input.tenantId = 'other-tenant'
        input.venueId = 'other-venue'
        input.version = 'changed'
        input.directory.places[0]!.longDescription = 'False replacement: no restrictions.'
        input.directory.places.length = 0
        return rawPlan
      },
    })
    if (output.status !== 'READY') throw new Error('expected READY')
    expect(output.result).toMatchObject({
      tenantId: 'tenant-test',
      venueId: 'venue-test',
      sourceVersion: 'v1',
      knownMatchCount: 1,
    })
    const data = JSON.parse(
      output.evidence.prompt.slice(output.evidence.prompt.lastIndexOf('\n') + 1),
    )
    expect(JSON.parse(data.rows[0].sourceText).longDescription).toBe(originalBody)
    expect(output.evidence.prompt).not.toContain('False replacement')
  })

  it('returns unsupported with trace and no manufactured result/evidence', async () => {
    const interpret = vi.fn(
      async () => '{"status":"UNSUPPORTED","reason":"Age and height cannot be represented."}',
    )
    const output = await prepareGuestQueryEvidence({
      source: source(),
      question: 'Which rides for age 7 and 44 inches?',
      interpret,
    })
    expect(output.status).toBe('UNSUPPORTED')
    expect(output.trace.plan).toEqual({
      status: 'UNSUPPORTED',
      reason: 'Age and height cannot be represented.',
    })
    expect(output).not.toHaveProperty('result')
    expect(output).not.toHaveProperty('evidence')
    expect(interpret).toHaveBeenCalledOnce()
  })

  it('binds question trace to the actual interpreter request even if callback mutates caller input', async () => {
    const input = {
      source: source(),
      question: 'Original question',
      interpret: async (request: { system: string; question: string }) => {
        expect(request.question).toBe('Original question')
        input.question = 'Mutated after dispatch'
        return rawPlan
      },
    }
    const output = await prepareGuestQueryEvidence(input)
    expect(output.trace.questionSha256).toBe(sha('Original question'))
  })

  it('preserves unknown feature results rather than promoting source prose/tags', async () => {
    const output = await prepareGuestQueryEvidence({
      source: source(),
      question: 'Which rides are family friendly?',
      interpret: async () =>
        JSON.stringify({
          status: 'QUERY',
          mode: 'list',
          predicates: [{ field: 'feature', name: 'family', value: true }],
        }),
    })
    if (output.status !== 'READY') throw new Error('expected READY')
    expect(output.result).toMatchObject({
      knownMatchCount: 0,
      unknownCandidateCount: 2,
      exactEligibleCount: null,
    })
    expect(output.evidence.includedKeys).toEqual([])
  })

  it.each([
    '{',
    '{"status":"QUERY","mode":"count","predicates":[]}',
    '{"status":"QUERY","mode":"count","predicates":[{"field":"kind","equals":"ATTRACTION"}],"tenantId":"attacker"}',
  ])('rejects malformed or scope-expanding interpreter output without retry', async (text) => {
    const interpret = vi.fn(async () => text)
    await expect(
      prepareGuestQueryEvidence({ source: source(), question: 'List rides', interpret }),
    ).rejects.toThrow()
    expect(interpret).toHaveBeenCalledOnce()
  })

  it('propagates interpreter transport failure without retry or fallback', async () => {
    const error = new Error('transport refused')
    const interpret = vi.fn(async (): Promise<string> => {
      throw error
    })
    await expect(
      prepareGuestQueryEvidence({ source: source(), question: 'List rides', interpret }),
    ).rejects.toBe(error)
    expect(interpret).toHaveBeenCalledOnce()
  })

  it.each(['', '   ', 'q'.repeat(16_001)])(
    'rejects invalid question before interpreter call',
    async (question) => {
      const interpret = vi.fn(async () => rawPlan)
      await expect(
        prepareGuestQueryEvidence({ source: source(), question, interpret }),
      ).rejects.toThrow(/question/)
      expect(interpret).not.toHaveBeenCalled()
    },
  )

  it('rejects inadmissible native scope before interpreter call instead of falling back', async () => {
    const interpret = vi.fn(async () => rawPlan)
    await expect(
      prepareGuestQueryEvidence({
        source: { ...source(), readPath: 'NATIVE' } as never,
        question: 'List rides',
        interpret,
      }),
    ).rejects.toThrow(/Unverified/)
    expect(interpret).not.toHaveBeenCalled()
  })
})
