import { describe, expect, it, vi } from 'vitest'

const redirect = vi.hoisted(() => vi.fn(() => undefined as never))
vi.mock('next/navigation', () => ({ redirect }))

import ChatDesignPage from './page'

describe('legacy chatbot design boundary', () => {
  it('redirects to tone presets without loading design tooling', () => {
    ChatDesignPage()
    expect(redirect).toHaveBeenCalledWith('/ai-controls')
  })
})
