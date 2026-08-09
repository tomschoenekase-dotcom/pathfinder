/* @vitest-environment jsdom */

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ createDashboardCaller: vi.fn(), listVenues: vi.fn() }))

vi.mock('../../../lib/server-caller', () => ({
  createDashboardCaller: mocks.createDashboardCaller,
}))

import ChatDesignPage from './page'

describe('ChatDesignPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createDashboardCaller.mockResolvedValue({ venue: { list: mocks.listVenues } })
  })

  it('propagates venue-list failures instead of presenting a false empty state', async () => {
    mocks.listVenues.mockRejectedValueOnce(new Error('Venue service unavailable'))

    await expect(ChatDesignPage()).rejects.toThrow('Venue service unavailable')
    expect(mocks.createDashboardCaller).toHaveBeenCalledWith('/chat-design')
  })
})
