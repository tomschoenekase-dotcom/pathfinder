import { describe, expect, it } from 'vitest'

import { GuestResponseBlock, GuestStructuredResponse } from './guest-response'

describe('GuestStructuredResponse', () => {
  it('accepts a versioned mix of browser-safe response blocks', () => {
    const result = GuestStructuredResponse.safeParse({
      version: 1,
      blocks: [
        { type: 'text', text: 'The west entrance is open.' },
        {
          type: 'actions',
          actions: [{ label: 'Visitor information', href: 'https://museum.example/visit' }],
        },
        {
          type: 'citations',
          citations: [{ label: 'Venue website', detail: 'Updated today' }],
        },
      ],
    })

    expect(result.success).toBe(true)
  })

  it.each(['javascript:alert(1)', 'data:text/html,bad', 'file:///secrets'])(
    'rejects the unsafe action URL %s',
    (href) => {
      expect(
        GuestResponseBlock.safeParse({
          type: 'actions',
          actions: [{ label: 'Unsafe', href }],
        }).success,
      ).toBe(false)
    },
  )

  it('rejects unknown blocks so clients do not guess at future payloads', () => {
    expect(GuestResponseBlock.safeParse({ type: 'html', html: '<b>unsafe</b>' }).success).toBe(
      false,
    )
  })
})
