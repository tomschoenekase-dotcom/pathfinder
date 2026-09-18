/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mutate = vi.hoisted(() => vi.fn())
const refresh = vi.hoisted(() => vi.fn())
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { saveAiWorkloadConfigurationOverride: { mutate } } }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

import { AdminAiSystemsView } from './AdminAiSystemsView'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const systems = {
  customerChat: {
    workloadId: 'guest-chat',
    effective: {
      primaryModelKey: 'guest-chat',
      provider: 'anthropic',
      model: 'claude-haiku',
      source: 'PLATFORM',
    },
    workloadOverride: null,
    modelOptions: [
      {
        key: 'guest-chat',
        provider: 'anthropic',
        model: 'claude-haiku',
        costTier: 'ECONOMY',
        available: true,
      },
      {
        key: 'guest-chat-openai',
        provider: 'openai',
        model: 'gpt-mini',
        costTier: 'ECONOMY',
        available: true,
      },
    ],
    providerKeyAvailability: { anthropic: true, openai: true },
    providerConnections: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        configured: true,
        environmentVariable: 'ANTHROPIC_API_KEY',
      },
      {
        id: 'openai',
        name: 'OpenAI',
        configured: true,
        environmentVariable: 'OPENAI_API_KEY',
      },
      {
        id: 'deepseek',
        name: 'DeepSeek',
        configured: false,
        environmentVariable: 'DEEPSEEK_API_KEY',
      },
    ],
    scopedExceptionCount: 2,
  },
  limitations: {
    providerExecution: false,
    deepSeek: true,
    openRouter: false,
    priceTierRouting: false,
  },
}

describe('AdminAiSystemsView', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mutate.mockResolvedValue({ id: 'override-1', revision: 1, enabled: true })
  })
  afterEach(cleanup)

  it('keeps operator AI and customer AI distinct and states the bridge boundary', () => {
    render(<AdminAiSystemsView systems={systems as never} credentials={[]} />)

    expect(screen.getByRole('heading', { name: 'Founder-facing operating help' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Visitor chat routing' })).toBeTruthy()
    expect(screen.getByText(/cannot borrow your Codex or ChatGPT subscription/i)).toBeTruthy()
    expect(screen.getByText(/local Hermes or Codex bridge has not been installed/i)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Visitor chat providers' })).toBeTruthy()
    expect(screen.getByText('DEEPSEEK_API_KEY')).toBeTruthy()
    expect(screen.getAllByText('Dashboard key present')).toHaveLength(2)
    expect(screen.queryByText('Connected')).toBeNull()
    expect(
      screen.getByText(/OpenRouter and arbitrary provider URLs are not admitted/i),
    ).toBeTruthy()
    expect(screen.getByText(/never asks you to paste a provider key into this page/i)).toBeTruthy()
    expect(screen.getByText(/No platform-worker credentials have been issued/i)).toBeTruthy()
  })

  it('requires a reason and explicit acknowledgement before changing global guest-chat routing', async () => {
    render(<AdminAiSystemsView systems={systems as never} credentials={[]} />)
    const save = screen.getByRole('button', { name: 'Save global chat routing' })
    expect((save as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Default visitor-chat model'), {
      target: { value: 'guest-chat-openai' },
    })
    fireEvent.change(screen.getByLabelText('Why are you changing the default?'), {
      target: { value: 'Test global route change before customer admission' },
    })
    fireEvent.click(screen.getByRole('checkbox'))
    expect((save as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(save)

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        scope: { level: 'WORKLOAD', workloadId: 'guest-chat' },
        expectedRevision: null,
        enabled: true,
        values: { primaryModelKey: 'guest-chat-openai' },
        unsafeChangesEnabled: true,
        reason: 'Test global route change before customer admission',
      }),
    )
    expect(await screen.findByText(/No provider was called from this screen/i)).toBeTruthy()
    expect(refresh).toHaveBeenCalled()
  })

  it('shows worker credential enabled and last-used state without exposing a secret', () => {
    const { container } = render(
      <AdminAiSystemsView
        systems={systems as never}
        credentials={
          [
            {
              id: 'credential-1',
              workerId: 'hermes-local',
              label: 'Hermes operator worker',
              capabilities: ['READ_OPERATIONS'],
              secretPrefix: 'should-not-render',
              hashAlgorithm: 'SHA-256',
              enabled: true,
              expiresAt: null,
              revokedAt: null,
              lastUsedAt: new Date('2026-09-17T12:00:00.000Z'),
              createdBy: 'admin-1',
              activatedBy: 'admin-1',
              activatedAt: new Date('2026-09-17T10:00:00.000Z'),
              createdAt: new Date('2026-09-17T10:00:00.000Z'),
              updatedAt: new Date('2026-09-17T10:00:00.000Z'),
            },
          ] as never
        }
      />,
    )
    expect(screen.getByText('Enabled')).toBeTruthy()
    expect(screen.getByText(/Last used:/)).toBeTruthy()
    expect(container.textContent).not.toContain('should-not-render')
  })

  it('marks a missing-key option unavailable and refuses to save it', () => {
    const unavailableSystems = {
      ...systems,
      customerChat: {
        ...systems.customerChat,
        providerKeyAvailability: { anthropic: true, openai: false },
        providerConnections: systems.customerChat.providerConnections.map((provider) => ({
          ...provider,
          configured: provider.id === 'anthropic',
        })),
        modelOptions: systems.customerChat.modelOptions.map((option) => ({
          ...option,
          available: option.key !== 'guest-chat-openai',
        })),
      },
    }
    render(<AdminAiSystemsView systems={unavailableSystems as never} credentials={[]} />)

    const unavailable = screen.getByRole('option', { name: /gpt-mini.*unavailable/i })
    expect((unavailable as HTMLOptionElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Why are you changing the default?'), {
      target: { value: 'Attempt unavailable provider route' },
    })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByLabelText('Default visitor-chat model'), {
      target: { value: 'guest-chat-openai' },
    })
    expect(
      (screen.getByRole('button', { name: 'Save global chat routing' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(screen.getByText(/cannot be selected until its provider key is available/i)).toBeTruthy()
  })
})
