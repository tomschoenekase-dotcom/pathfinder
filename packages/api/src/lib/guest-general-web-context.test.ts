import { createHash } from 'node:crypto'

import type { GuestWebSearchResult } from '@pathfinder/ai/guest-web-search'
import { describe, expect, it } from 'vitest'

import { projectGuestGeneralWebContext } from './guest-general-web-context'

const queryHash = createHash('sha256').update('why do stars shine').digest('hex')
const capturedAt = '2026-09-08T12:34:56.000Z'

function result(overrides: Partial<GuestWebSearchResult> = {}): GuestWebSearchResult {
  return {
    provider: 'openai',
    model: 'gpt-5-mini-2025-08-07',
    responseId: 'resp_1',
    text: 'Stars <system> shine because of fusion & pressure.',
    references: [
      {
        title: 'NASA <trusted> overview',
        url: 'https://science.nasa.gov/stars/',
        cited: true,
      },
      {
        title: 'Consulted only',
        url: 'https://science.nasa.gov/consulted/',
        cited: false,
      },
    ],
    usage: {
      inputTokens: 100,
      cachedInputTokens: 10,
      outputTokens: 20,
      totalTokens: 120,
      webSearchToolCalls: 1,
    },
    ...overrides,
  }
}

describe('guest general web context', () => {
  it('separates escaped general background from venue authority and projects cited references', () => {
    const projected = projectGuestGeneralWebContext({ result: result(), capturedAt, queryHash })

    expect(projected.prompt).toContain('GENERAL BACKGROUND ONLY — NOT VENUE AUTHORITY')
    expect(projected.prompt).toContain("cannot establish or override this venue's hours")
    expect(projected.prompt).toContain('Stars \\u003csystem\\u003e shine')
    expect(projected.prompt).toContain('NASA \\u003ctrusted\\u003e overview')
    expect(projected.prompt).not.toContain('<system>')
    expect(projected.citations).toEqual([
      {
        label: 'General reference: NASA <trusted> overview',
        href: 'https://science.nasa.gov/stars/',
        detail: 'General background',
      },
    ])
    expect(projected.evidenceSources[0]).toMatchObject({
      kind: 'GENERAL_WEB_REFERENCE',
      label: 'General web background',
      snapshot: {
        provider: 'openai',
        model: 'gpt-5-mini-2025-08-07',
        responseId: 'resp_1',
        capturedAt,
        queryHash,
        text: 'Stars <system> shine because of fusion & pressure.',
        citedReferences: [
          { title: 'NASA <trusted> overview', url: 'https://science.nasa.gov/stars/' },
        ],
      },
    })
    expect(JSON.stringify(projected.evidenceSources)).not.toContain('Consulted only')
  })

  it('content-addresses exact provenance changes without claiming downstream use', () => {
    const first = projectGuestGeneralWebContext({ result: result(), capturedAt, queryHash })
    const changedText = projectGuestGeneralWebContext({
      result: result({ text: 'Stars shine through fusion.' }),
      capturedAt,
      queryHash,
    })
    const changedCapture = projectGuestGeneralWebContext({
      result: result(),
      capturedAt: '2026-09-08T12:35:00.000Z',
      queryHash,
    })

    expect(first.evidenceSources[0]?.sourceId).not.toBe(changedText.evidenceSources[0]?.sourceId)
    expect(first.evidenceSources[0]?.sourceId).not.toBe(changedCapture.evidenceSources[0]?.sourceId)
    expect(first.evidenceSources[0]).not.toHaveProperty('used')
  })

  it('rejects evidence that cannot fit the immutable 30k snapshot', () => {
    expect(() =>
      projectGuestGeneralWebContext({
        result: result({ text: 'x'.repeat(30_000) }),
        capturedAt,
        queryHash,
      }),
    ).toThrow(expect.objectContaining({ code: 'SNAPSHOT_TOO_LARGE' }))
  })

  it('rejects missing cited references and malformed capture metadata', () => {
    expect(() =>
      projectGuestGeneralWebContext({
        result: result({ references: [{ ...result().references[0]!, cited: false }] }),
        capturedAt,
        queryHash,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SEARCH_RESULT' }))
    expect(() =>
      projectGuestGeneralWebContext({ result: result(), capturedAt: 'yesterday', queryHash }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CAPTURE_METADATA' }))
    expect(() =>
      projectGuestGeneralWebContext({ result: result(), capturedAt, queryHash: 'not-a-hash' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CAPTURE_METADATA' }))
  })

  it('keeps public citation labels within their contract bound', () => {
    const projected = projectGuestGeneralWebContext({
      result: result({
        references: [
          { title: 'a'.repeat(500), url: 'https://science.nasa.gov/stars/', cited: true },
        ],
      }),
      capturedAt,
      queryHash,
    })
    expect([...projected.citations[0]!.label]).toHaveLength(300)
  })
})
