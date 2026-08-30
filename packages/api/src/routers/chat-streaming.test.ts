import { describe, expect, it, vi } from 'vitest'

import { boundedStreamingPrefix, createGuestStreamingProjection } from './chat'

describe('guest chat streaming projection', () => {
  it('never exposes the internal engagement marker in transient fragments', async () => {
    const onTextDelta = vi.fn()
    const projection = createGuestStreamingProjection({ maxWords: 40, onTextDelta })

    await projection.push('A useful answer. [[ENGAGE', {
      providerFirstTextMs: 120,
      requestFirstTextMs: 220,
    })
    await projection.push('MENT_ASKED]]', {
      providerFirstTextMs: 140,
      requestFirstTextMs: 240,
    })

    expect(onTextDelta.mock.calls.map(([delta]) => delta).join('')).toBe('A useful answer. ')
    expect(onTextDelta.mock.calls.flat().join('')).not.toContain('ENGAGEMENT_ASKED')
    expect(projection.providerFirstTextMs()).toBe(120)
    expect(projection.requestFirstTextMs()).toBe(220)
  })

  it('bounds transient text to the configured word ceiling before final authority arrives', async () => {
    const onTextDelta = vi.fn()
    const projection = createGuestStreamingProjection({ maxWords: 3, onTextDelta })

    await projection.push('One two three four five six seven eight nine ten. Extra padding.', {
      providerFirstTextMs: 80,
      requestFirstTextMs: 180,
    })

    expect(onTextDelta.mock.calls.map(([delta]) => delta).join('')).toBe('One two three')
    expect(boundedStreamingPrefix('One two three four', 3)).toBe('One two three')
  })
})
