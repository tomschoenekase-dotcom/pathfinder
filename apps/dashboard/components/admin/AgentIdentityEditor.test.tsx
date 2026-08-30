/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createIdentity = vi.hoisted(() => vi.fn())
const editIdentity = vi.hoisted(() => vi.fn())
const disableIdentity = vi.hoisted(() => vi.fn())
const enableIdentity = vi.hoisted(() => vi.fn())
const refresh = vi.hoisted(() => vi.fn())
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      createDisabledAgentIdentity: { mutate: createIdentity },
      editDisabledAgentIdentity: { mutate: editIdentity },
      disableAgentIdentity: { mutate: disableIdentity },
      enableAgentIdentity: { mutate: enableIdentity },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

import { AgentIdentityCreateEditor, AgentIdentityEditEditor } from './AgentIdentityEditor'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const identity = {
  id: 'agent_1',
  identityKey: 'content.primary',
  name: 'Content agent',
  description: null,
  agentType: 'CONTENT',
  accessCapabilities: ['content.read', 'content.draft'],
  autonomyLevel: 'DRAFT',
  autonomousActions: ['content.prepare-draft'],
  enabled: false,
  updatedAt: new Date('2026-08-11T14:30:00.000Z'),
} as const

describe('AgentIdentityEditor', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    createIdentity.mockResolvedValue({ id: 'agent_2', enabled: false })
    editIdentity.mockResolvedValue({ id: 'agent_1', enabled: false })
    disableIdentity.mockResolvedValue({ id: 'agent_1', enabled: false })
    enableIdentity.mockResolvedValue({ id: 'agent_1', enabled: true })
  })
  afterEach(cleanup)

  it('creates only an exact-venue disabled identity from allowlisted values', async () => {
    const { container } = render(
      <AgentIdentityCreateEditor tenantId="tenant_1" venueId="venue_1" />,
    )
    fireEvent.click(screen.getAllByText('Create disabled identity')[0]!)
    fireEvent.change(screen.getByLabelText('Identity key'), {
      target: { value: 'content.secondary' },
    })
    fireEvent.change(screen.getByLabelText('Display name'), {
      target: { value: 'Secondary content agent' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create disabled identity' }))
    await waitFor(() => expect(createIdentity).toHaveBeenCalledOnce())
    expect(createIdentity).toHaveBeenCalledWith({
      scope: { level: 'VENUE', tenantId: 'tenant_1', venueId: 'venue_1' },
      fields: {
        identityKey: 'content.secondary',
        name: 'Secondary content agent',
        description: null,
        agentType: 'CONTENT',
        accessCapabilities: ['content.read'],
        autonomyLevel: 'READ_ONLY',
        autonomousActions: [],
      },
    })
    expect(container.textContent).toMatch(/execution route|bridge model target/i)
    expect(container.textContent).not.toMatch(/credential|api key/i)
    expect(screen.queryByRole('button', { name: /enable|run agent/i })).toBeNull()
  })

  it('offers narrow reviewed role templates without enabling or running them', () => {
    render(<AgentIdentityCreateEditor tenantId="tenant_1" venueId="venue_1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Primary coordinator' }))
    expect((screen.getByLabelText('Identity key') as HTMLInputElement).value).toBe('edith.primary')
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('EDITH')
    expect((screen.getByLabelText('Identity type') as HTMLSelectElement).value).toBe('PRIMARY')
    expect(createIdentity).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /enable|run agent/i })).toBeNull()
  })

  it('enables a saved identity only when its provider and model are configured', async () => {
    render(
      <AgentIdentityEditEditor
        tenantId="tenant_1"
        venueId="venue_1"
        identity={
          {
            ...identity,
            defaultProvider: 'anthropic',
            defaultModel: 'central:agent-run',
          } as never
        }
      />,
    )
    fireEvent.click(screen.getByText('Edit disabled configuration'))
    fireEvent.click(screen.getByRole('button', { name: 'Enable configured identity' }))
    await waitFor(() =>
      expect(enableIdentity).toHaveBeenCalledWith({
        scope: { level: 'VENUE', tenantId: 'tenant_1', venueId: 'venue_1' },
        agentIdentityId: 'agent_1',
        expectedUpdatedAt: identity.updatedAt,
      }),
    )
  })

  it('makes direct model selection truthful and links to governed workload controls', async () => {
    render(<AgentIdentityCreateEditor tenantId="tenant_1" venueId="venue_1" />)
    fireEvent.click(screen.getAllByText('Create disabled identity')[0]!)
    fireEvent.change(screen.getByLabelText('Execution route'), {
      target: { value: 'anthropic' },
    })
    const workload = (await screen.findByLabelText(/Managed workload/)) as HTMLInputElement
    expect(workload.value).toBe('central:agent-run')
    expect(workload.disabled).toBe(true)
    expect(
      screen.getByRole('link', { name: 'AI workload configuration' }).getAttribute('href'),
    ).toBe('/admin/clients/tenant_1/venues/venue_1/ai-configuration')
    expect(
      screen.getByText(/Saving or enabling this identity does not call a provider/i),
    ).toBeTruthy()
  })

  it('edits a disabled identity with its immutable scope and expected revision', async () => {
    render(
      <AgentIdentityEditEditor
        tenantId="tenant_1"
        venueId="venue_1"
        identity={identity as never}
      />,
    )
    fireEvent.click(screen.getByText('Edit disabled configuration'))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Draft agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save disabled configuration' }))
    await waitFor(() => expect(editIdentity).toHaveBeenCalledOnce())
    expect(editIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { level: 'VENUE', tenantId: 'tenant_1', venueId: 'venue_1' },
        agentIdentityId: 'agent_1',
        expectedUpdatedAt: identity.updatedAt,
        fields: expect.objectContaining({ name: 'Draft agent' }),
      }),
    )
  })

  it('reports duplicate-key conflict with an inspect-and-refresh recovery path', async () => {
    createIdentity.mockRejectedValueOnce({ data: { code: 'CONFLICT' } })
    render(<AgentIdentityCreateEditor tenantId="tenant_1" venueId="venue_1" />)
    fireEvent.change(screen.getByLabelText('Identity key'), {
      target: { value: 'content.primary' },
    })
    fireEvent.change(screen.getByLabelText('Display name'), {
      target: { value: 'Content agent' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create disabled identity' }))
    expect(
      await screen.findByText(/Refresh to inspect the existing disabled identity/i),
    ).toBeTruthy()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('locks enabled configuration and exposes disable only', async () => {
    render(
      <AgentIdentityEditEditor
        tenantId="tenant_1"
        venueId="venue_1"
        identity={{ ...identity, enabled: true } as never}
      />,
    )
    fireEvent.click(screen.getAllByText('Disable identity')[0]!)
    expect(screen.queryByLabelText('Display name')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Disable identity' }))
    await waitFor(() => expect(disableIdentity).toHaveBeenCalledOnce())
    expect(editIdentity).not.toHaveBeenCalled()
  })
})
