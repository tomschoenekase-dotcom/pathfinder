import { afterEach, describe, expect, it, vi } from 'vitest'

const redirect = vi.hoisted(() =>
  vi.fn((target: string) => {
    throw new Error(`NEXT_REDIRECT:${target}`)
  }),
)
vi.mock('next/navigation', () => ({ redirect }))

import VenueLandingPage from './page'

async function visit(venueSlug: string, query: Record<string, string | string[] | undefined> = {}) {
  await expect(
    VenueLandingPage({
      params: Promise.resolve({ venueSlug }),
      searchParams: Promise.resolve(query),
    }),
  ).rejects.toThrow('NEXT_REDIRECT')
  return redirect.mock.calls.at(-1)?.[0]
}

describe('venue landing redirect', () => {
  afterEach(() => vi.clearAllMocks())

  it('sends a plain venue link straight into the guide', async () => {
    expect(await visit('sample-venue')).toBe('/sample-venue/chat')
  })

  it('keeps prompt, QR source and place entry parameters', async () => {
    expect(
      await visit('sample-venue', { prompt: 'Where is the café?', source: 'qr', entry: 'p1' }),
    ).toBe('/sample-venue/chat?prompt=Where+is+the+caf%C3%A9%3F&source=qr&entry=p1')
  })

  it('keeps repeated parameters and skips undefined ones', async () => {
    expect(await visit('sample-venue', { item: ['a', 'b'], ask: undefined })).toBe(
      '/sample-venue/chat?item=a&item=b',
    )
  })
})
