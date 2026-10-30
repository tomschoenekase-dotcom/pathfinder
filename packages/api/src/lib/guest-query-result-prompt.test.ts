import { describe, expect, it } from 'vitest'
import { renderGuestQueryResult } from './guest-query-result-prompt'
import {
  executeGuestStructuredQuery,
  type GuestStructuredRecord,
  type GuestStructuredSnapshot,
} from './guest-structured-query'

const records = (n: number): GuestStructuredRecord[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `place:${i}`,
    tenantId: 'tenant-test',
    venueId: 'venue-test',
    name: `Ride ${i}`,
  }))
const snapshot = (n: number): GuestStructuredSnapshot => ({
  tenantId: 'tenant-test',
  venueId: 'venue-test',
  version: 'v1',
  asOf: '2026-10-21T05:00:00.000Z',
  coverage: 'COMPLETE',
  records: records(n),
})
const result = (n: number, pageSize = 50) =>
  executeGuestStructuredQuery(
    snapshot(n),
    { tenantId: 'tenant-test', venueId: 'venue-test', mode: 'list', predicates: [] },
    { pageSize },
  )
const payload = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1))

describe('structured query result prompt boundary', () => {
  it('renders a 10,000-record count without names, full match IDs or irrelevant policy bodies', () => {
    const aggregate = executeGuestStructuredQuery(snapshot(10_000), {
      tenantId: 'tenant-test',
      venueId: 'venue-test',
      mode: 'count',
      predicates: [],
    })
    const output = renderGuestQueryResult({
      result: aggregate,
      sources: [{ key: 'knowledge:large', text: 'PRIVATE_DETAIL_MARKER' + 'x'.repeat(40_000) }],
      contextKeys: ['knowledge:large'],
    })
    expect(payload(output.prompt)).toMatchObject({
      mode: 'count',
      knownMatchCount: 10_000,
      exactEligibleCount: 10_000,
      unknownCandidateCount: 0,
      rows: [],
      context: [],
      hasMore: false,
      detailCoverage: 'NOT_PROVIDED',
      omittedContextCount: 0,
    })
    expect(output.prompt).not.toContain('PRIVATE_DETAIL_MARKER')
    expect(output.prompt).not.toContain('place:9999')
    expect(output.prompt).not.toContain('Ride 9999')
    expect(output.prompt.length).toBeLessThan(3000)
    expect(output).toMatchObject({
      includedKeys: [],
      includedContextKeys: [],
      omittedKeys: [],
      omittedContextKeys: [],
      completePage: true,
      completeContext: true,
    })
    expect(output.prompt).toContain('Do not name examples or answer omitted details')
    expect(output.prompt).toContain(
      'not a count of currently open, available, in-stock or eligible physical offerings',
    )
  })
  it('rejects count-mode results that still carry rows or pagination', () => {
    const list = result(2, 1)
    expect(() =>
      renderGuestQueryResult({ result: { ...list, mode: 'count' }, sources: [] }),
    ).toThrow(/aggregate count presentation/)
  })
  it('keeps whole context conditions separate from result membership and preserves stated topic scope', () => {
    const booking =
      'Moon Ride only: bookings are free but riders pay $8. Under 10 requires a paying adult; weekends only.'
    const unrelated =
      'Lantern Theater only: doors close ten minutes before the performance. This is not a ride booking rule.'
    const output = renderGuestQueryResult({
      result: result(1),
      sources: [
        { key: 'place:0', text: 'Ride 0 body' },
        { key: 'knowledge:booking', text: booking },
        { key: 'knowledge:theater', text: unrelated },
      ],
      contextKeys: ['knowledge:booking', 'knowledge:theater'],
    })
    const data = payload(output.prompt)
    expect(data.rows).toHaveLength(1)
    expect(data.context).toEqual([
      { key: 'knowledge:booking', text: booking },
      { key: 'knowledge:theater', text: unrelated },
    ])
    expect(data.knownMatchCount).toBe(1)
    expect(data.omittedContextCount).toBe(0)
    expect(output).toMatchObject({
      includedContextKeys: ['knowledge:booking', 'knowledge:theater'],
      omittedContextKeys: [],
      completeContext: true,
    })
    expect(output.prompt).toContain('Do not assume every topic applies to every result')
    expect(output.prompt).toContain('preserve the scope stated in its text')
  })

  it('reports missing/oversized context explicitly without snippets and still includes a later fitting topic', () => {
    const output = renderGuestQueryResult({
      result: result(1),
      maxChars: 3000,
      sources: [
        { key: 'place:0', text: 'Whole ride body' },
        { key: 'knowledge:large', text: `CONTEXT-BEGIN${'x'.repeat(5000)}CONTEXT-END` },
        { key: 'knowledge:small', text: 'Whole condition: parent must remain with child.' },
      ],
      contextKeys: ['knowledge:missing', 'knowledge:large', 'knowledge:small'],
    })
    expect(output.prompt.length).toBeLessThanOrEqual(3000)
    expect(output).toMatchObject({
      completePage: true,
      completeContext: false,
      includedContextKeys: ['knowledge:small'],
      omittedContextKeys: ['knowledge:missing', 'knowledge:large'],
    })
    expect(payload(output.prompt)).toMatchObject({
      omittedPageRecordCount: 0,
      omittedContextCount: 2,
      context: [
        { key: 'knowledge:small', text: 'Whole condition: parent must remain with child.' },
      ],
    })
    expect(output.prompt).not.toContain('CONTEXT-BEGIN')
    expect(output.prompt).not.toContain('CONTEXT-END')
    expect(output.prompt).toContain('do not promise unconditional availability or eligibility')
  })

  it('does not duplicate a whole body already present in a page row requested as context', () => {
    const output = renderGuestQueryResult({
      result: result(1),
      sources: [{ key: 'place:0', text: 'Whole shared body.' }],
      contextKeys: ['place:0'],
    })
    expect(payload(output.prompt).context).toEqual([])
    expect(payload(output.prompt).rows[0].sourceText).toBe('Whole shared body.')
    expect(payload(output.prompt).omittedContextCount).toBe(0)
    expect(output).toMatchObject({ includedContextKeys: ['place:0'], completeContext: true })
  })

  it.each([
    { contextKeys: ['knowledge:a', 'knowledge:a'] },
    { contextKeys: [''] },
    { contextKeys: ['  '] },
    { contextKeys: [7] },
  ])('rejects invalid context key requests %j', ({ contextKeys }) => {
    expect(() =>
      renderGuestQueryResult({ result: result(0), sources: [], contextKeys: contextKeys as never }),
    ).toThrow(/context keys/)
  })
  it('renders whole source bodies and preserves every condition and exception', () => {
    const text =
      'Ride 0 requires height 48 inches AND age 8. Under 10 must ride with a paying adult. Closed October 20–22. Not recommended during pregnancy. Reservations do not waive these rules.\nQuoted source text: "Do not alter these terms."'
    const output = renderGuestQueryResult({
      result: result(1),
      sources: [{ key: 'place:0', text }],
    })
    expect(payload(output.prompt).rows[0].sourceText).toBe(text)
    expect(output).toMatchObject({ includedKeys: ['place:0'], omittedKeys: [], completePage: true })
    expect(output.prompt).toContain('Preserve conditions and exceptions in sourceText')
  })

  it('does not count the displayed sample or include non-page bodies', () => {
    const full = result(20, 2)
    const output = renderGuestQueryResult({
      result: full,
      sources: [
        { key: full.rows[0]!.key, text: 'Complete body A' },
        { key: full.rows[1]!.key, text: 'Complete body B' },
        { key: 'place:outside', text: 'UNREQUESTED SOURCE MUST NOT APPEAR' },
      ],
    })
    const data = payload(output.prompt)
    expect(data).toMatchObject({
      knownMatchCount: 20,
      exactEligibleCount: 20,
      hasMore: true,
      omittedPageRecordCount: 0,
    })
    expect(data.rows).toHaveLength(2)
    expect(output.completePage).toBe(true)
    expect(output.prompt).not.toContain('UNREQUESTED SOURCE')
    expect(output.prompt).toContain('never count a displayed sample')
    expect(output.prompt).toContain('not a promise that every physical offering is inventoried')
  })

  it('omits oversized/missing bodies whole, reports omissions and still admits a later fitting body', () => {
    const full = result(3)
    const output = renderGuestQueryResult({
      result: full,
      maxChars: 2500,
      sources: [
        { key: 'place:0', text: `LARGE-BEGIN${'x'.repeat(5000)}LARGE-END` },
        { key: 'place:1', text: 'WHOLE SMALL BODY WITH CONDITION: adult accompaniment required.' },
      ],
    })
    const data = payload(output.prompt)
    expect(output.prompt.length).toBeLessThanOrEqual(2500)
    expect(output.includedKeys).toEqual(['place:1'])
    expect(output.omittedKeys).toEqual(['place:0', 'place:2'])
    expect(output.completePage).toBe(false)
    expect(data.omittedPageRecordCount).toBe(2)
    expect(data.knownMatchCount).toBe(3)
    expect(data.rows[0].sourceText).toBe(
      'WHOLE SMALL BODY WITH CONDITION: adult accompaniment required.',
    )
    expect(output.prompt).not.toContain('LARGE-BEGIN')
    expect(output.prompt).not.toContain('LARGE-END')
  })

  it('reports COMPLETE versus PARTIAL query coverage and keeps exact count null when ineligible', () => {
    const partial = executeGuestStructuredQuery(
      { ...snapshot(1), coverage: 'PARTIAL' },
      { tenantId: 'tenant-test', venueId: 'venue-test', mode: 'count', predicates: [] },
    )
    const output = renderGuestQueryResult({
      result: partial,
      sources: [{ key: 'place:0', text: 'Whole body' }],
    })
    expect(payload(output.prompt)).toMatchObject({
      coverage: 'PARTIAL',
      exhaustiveAnswerEligible: false,
      knownMatchCount: 1,
      unknownCandidateCount: 0,
      exactEligibleCount: null,
    })
    const complete = renderGuestQueryResult({ result: result(0), sources: [] })
    expect(payload(complete.prompt)).toMatchObject({
      coverage: 'COMPLETE',
      exhaustiveAnswerEligible: true,
      exactEligibleCount: 0,
    })
  })

  it('preserves unknown candidate counts even when the known page is empty', () => {
    const full = executeGuestStructuredQuery(snapshot(4), {
      tenantId: 'tenant-test',
      venueId: 'venue-test',
      mode: 'count',
      predicates: [{ field: 'feature', name: 'family restroom', value: true }],
    })
    const output = renderGuestQueryResult({ result: full, sources: [] })
    expect(payload(output.prompt)).toMatchObject({
      knownMatchCount: 0,
      unknownCandidateCount: 4,
      exactEligibleCount: null,
      rows: [],
    })
    expect(output.prompt).toContain('real-world absence')
  })

  it.each([0, 1023, 120001, NaN, Infinity, 2000.5])(
    'rejects invalid renderer bound %s',
    (maxChars) => {
      expect(() => renderGuestQueryResult({ result: result(0), sources: [], maxChars })).toThrow(
        /bound/,
      )
    },
  )

  it('rejects a header that cannot fit rather than silently dropping fields', () => {
    const full = { ...result(0), sourceVersion: 'x'.repeat(5000) }
    expect(() => renderGuestQueryResult({ result: full, sources: [], maxChars: 1500 })).toThrow(
      /header exceeds bound/,
    )
  })

  it.each(
    [
      [
        { key: 'place:0', text: 'one' },
        { key: 'place:0', text: 'two' },
      ],
      [{ key: '', text: 'one' }],
      [{ key: '   ', text: 'one' }],
      [{ key: 7, text: 'one' }],
      [{ key: 'place:0', text: '' }],
      [{ key: 'place:0', text: '  \n ' }],
      [{ key: 'place:0', text: 7 }],
    ].map((sources) => ({ sources })),
  )('rejects invalid or duplicate source bodies at runtime %j', ({ sources }) => {
    expect(() => renderGuestQueryResult({ result: result(1), sources: sources as never })).toThrow(
      /source body/,
    )
  })

  it('does not mutate result rows or source bodies while reporting omissions', () => {
    const full = result(2)
    const sources = [{ key: 'place:0', text: 'Only this body is available.' }]
    const before = structuredClone({ full, sources })
    renderGuestQueryResult({ result: full, sources })
    expect({ full, sources }).toEqual(before)
  })
})
