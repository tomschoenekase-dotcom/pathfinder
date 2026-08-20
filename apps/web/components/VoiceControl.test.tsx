/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  availability: vi.fn(),
  start: vi.fn(),
  connected: vi.fn(),
  transcript: vi.fn(),
  usage: vi.fn(),
  end: vi.fn(),
  getUserMedia: vi.fn(),
}))

vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => ({
    voice: {
      availability: { query: mocks.availability },
      start: { mutate: mocks.start },
      connected: { mutate: mocks.connected },
      transcript: { mutate: mocks.transcript },
      usage: { mutate: mocks.usage },
      end: { mutate: mocks.end },
    },
  }),
}))

import { VoiceControl } from './VoiceControl'

const props = {
  venueId: 'venue-1',
  anonymousToken: '123e4567-e89b-42d3-a456-426614174000',
  language: 'English' as const,
  disabled: false,
}

describe('VoiceControl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: mocks.getUserMedia },
    })
    vi.stubGlobal('RTCPeerConnection', class {})
    vi.stubGlobal('React', React)
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('does not expose a half-working control when voice is unavailable', async () => {
    mocks.availability.mockResolvedValue({ enabled: false, premiumAvailable: false })
    render(<VoiceControl {...props} />)
    await waitFor(() => expect(mocks.availability).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Start voice conversation' })).toBeNull()
  })

  it('handles denied microphone permission without requesting provider authorization', async () => {
    mocks.availability.mockResolvedValue({ enabled: true, premiumAvailable: false })
    mocks.getUserMedia.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'))
    render(<VoiceControl {...props} />)
    const start = await screen.findByRole('button', { name: 'Start voice conversation' })
    fireEvent.click(start)
    expect((await screen.findByRole('alert')).textContent).toContain('Microphone access was denied')
    expect(mocks.start).not.toHaveBeenCalled()
  })
})
