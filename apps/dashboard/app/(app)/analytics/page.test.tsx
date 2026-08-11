import { beforeEach, describe, expect, it, vi } from 'vitest'

const redirect = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_REDIRECT')
  }),
)

vi.mock('next/navigation', () => ({ redirect }))

import AnalyticsPage from './page'

describe('client analytics compatibility route', () => {
  beforeEach(() => vi.clearAllMocks())

  it('redirects direct access home without fetching or rendering analytics', () => {
    expect(() => AnalyticsPage()).toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/')
  })
})
