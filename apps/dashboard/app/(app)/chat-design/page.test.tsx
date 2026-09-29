import { describe, expect, it, vi } from 'vitest'

const redirect = vi.hoisted(() => vi.fn(() => undefined as never))
vi.mock('next/navigation', () => ({ redirect }))

import ChatDesignPage from './page'

describe('legacy chatbot design boundary', () => {
  it('redirects legacy design links to Look & feel without loading design tooling', () => {
    ChatDesignPage()
    expect(redirect).toHaveBeenCalledWith('/look-and-feel')
  })
})
