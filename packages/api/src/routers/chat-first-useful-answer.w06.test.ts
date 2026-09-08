import { describe, expect, it, vi } from 'vitest'

import { createGuestStreamingProjection } from './chat'

describe('W06 first useful answer timing', () => {
  it('starts first-text timing at the first guest-visible non-whitespace delta', async () => {
    const onTextDelta = vi.fn()
    const projection = createGuestStreamingProjection({ onTextDelta })

    await projection.push('   ', {
      providerFirstTextMs: 25,
      requestFirstTextMs: 40,
    })

    expect(projection.providerFirstTextMs()).toBeNull()
    expect(projection.requestFirstTextMs()).toBeNull()

    await projection.push('Museum hours are 10:00 to 16:00. [[ENGAGEMENT_ASKED]]', {
      providerFirstTextMs: 90,
      requestFirstTextMs: 125,
    })

    expect(onTextDelta.mock.calls.map(([delta]) => delta).join('')).toBe(
      '   Museum hours are 10:00 to 16:00. ',
    )
    expect(projection.providerFirstTextMs()).toBe(90)
    expect(projection.requestFirstTextMs()).toBe(125)

    await projection.push('Later detail.', {
      providerFirstTextMs: 180,
      requestFirstTextMs: 230,
    })

    expect(projection.providerFirstTextMs()).toBe(90)
    expect(projection.requestFirstTextMs()).toBe(125)
  })

  it('does not record useful-answer timing for whitespace-only completion', async () => {
    const onTextDelta = vi.fn()
    const projection = createGuestStreamingProjection({ onTextDelta })

    await projection.push(' '.repeat(40), {
      providerFirstTextMs: 25,
      requestFirstTextMs: 40,
    })

    expect(onTextDelta).not.toHaveBeenCalled()
    expect(projection.providerFirstTextMs()).toBeNull()
    expect(projection.requestFirstTextMs()).toBeNull()
  })

  it('does not record useful-answer timing for a split internal marker', async () => {
    const onTextDelta = vi.fn()
    const projection = createGuestStreamingProjection({ onTextDelta })

    await projection.push('[[ENGAGE', {
      providerFirstTextMs: 25,
      requestFirstTextMs: 40,
    })
    await projection.push('MENT_ASKED]]', {
      providerFirstTextMs: 35,
      requestFirstTextMs: 50,
    })

    expect(onTextDelta).not.toHaveBeenCalled()
    expect(projection.providerFirstTextMs()).toBeNull()
    expect(projection.requestFirstTextMs()).toBeNull()
  })
})
