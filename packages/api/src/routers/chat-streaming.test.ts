import { describe, expect, it, vi } from 'vitest'

import { createGuestStreamingProjection } from './chat'

describe('guest chat streaming projection', () => {
  it('emits short useful text immediately without a full-marker lookbehind delay', async () => {
    const onTextDelta = vi.fn()
    const projection = createGuestStreamingProjection({ onTextDelta })
    await projection.push('Yes.', { providerFirstTextMs: 20, requestFirstTextMs: 30 })
    expect(onTextDelta).toHaveBeenCalledWith('Yes.', {
      providerFirstTextMs: 20,
      requestFirstTextMs: 30,
    })
  })

  it('withholds only actual marker prefixes across every split and releases a false prefix', async () => {
    const marker = '[[ENGAGEMENT_ASKED]]'
    for (let split = 1; split < marker.length; split += 1) {
      const onTextDelta = vi.fn()
      const projection = createGuestStreamingProjection({ onTextDelta })
      await projection.push(`Go left. ${marker.slice(0, split)}`, {
        providerFirstTextMs: 20,
        requestFirstTextMs: 30,
      })
      expect(onTextDelta.mock.calls.map(([delta]) => delta).join('')).toBe('Go left. ')
      await projection.push(marker.slice(split), {
        providerFirstTextMs: 40,
        requestFirstTextMs: 50,
      })
      expect(onTextDelta.mock.calls.map(([delta]) => delta).join('')).toBe('Go left. ')
    }
    const onTextDelta = vi.fn()
    const projection = createGuestStreamingProjection({ onTextDelta })
    await projection.push('Look [', { providerFirstTextMs: 20, requestFirstTextMs: 30 })
    await projection.push('at this].', { providerFirstTextMs: 40, requestFirstTextMs: 50 })
    expect(onTextDelta.mock.calls.map(([delta]) => delta).join('')).toBe('Look [at this].')
  })

  it('never exposes the internal engagement marker in transient fragments', async () => {
    const onTextDelta = vi.fn()
    const projection = createGuestStreamingProjection({ onTextDelta })

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

  it('keeps later restrictions visible in transient text beyond the brevity target', async () => {
    const onTextDelta = vi.fn()
    const projection = createGuestStreamingProjection({ onTextDelta })
    const answer = `${'The gallery has a flight display. '.repeat(20)}The lift is closed today.`

    await projection.push(answer + ' [[ENGAGEMENT_ASKED]]', {
      providerFirstTextMs: 80,
      requestFirstTextMs: 180,
    })

    expect(onTextDelta.mock.calls.map(([delta]) => delta).join('')).toBe(answer + ' ')
  })
})
