import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentIdentityConfigurationFields } from '@pathfinder/contracts'

const writeAudit = vi.hoisted(() => vi.fn())
vi.mock('./audit', () => ({ writeAuditLogStrict: writeAudit }))

import {
  AgentIdentityConfigurationError,
  createDisabledAgentIdentity,
  disableAgentIdentity,
  editDisabledAgentIdentity,
  enableAgentIdentity,
} from './agent-identity-configuration-actions'

const revision = new Date('2026-08-11T14:30:00.000Z')
const nextRevision = new Date('2026-08-11T14:31:00.000Z')
const actor = { type: 'HUMAN', id: 'admin_1', role: 'PLATFORM_ADMIN' } as const
const venueScope = { level: 'VENUE', tenantId: 'tenant_1', venueId: 'venue_1' } as const
const clientScope = { level: 'CLIENT', tenantId: 'tenant_1' } as const
const fields: AgentIdentityConfigurationFields = {
  identityKey: 'content.primary',
  name: 'Content agent',
  description: 'Prepares reviewed content drafts.',
  agentType: 'CONTENT',
  accessCapabilities: ['content.read', 'content.draft'],
  autonomyLevel: 'DRAFT',
  autonomousActions: ['content.prepare-draft'],
}

function identity(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent_1',
    tenantId: 'tenant_1',
    venueId: 'venue_1',
    identityKey: fields.identityKey,
    name: fields.name,
    description: fields.description,
    agentType: fields.agentType,
    accessScope: 'VENUE',
    accessCapabilities: [...fields.accessCapabilities],
    autonomyLevel: fields.autonomyLevel,
    autonomousActions: [...fields.autonomousActions],
    defaultProvider: null,
    defaultModel: null,
    enabled: false,
    createdBy: 'admin_1',
    createdAt: revision,
    updatedAt: revision,
    ...overrides,
  }
}

function harness() {
  const tx = {
    tenant: { findFirst: vi.fn().mockResolvedValue({ id: 'tenant_1' }) },
    venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue_1' }) },
    agentIdentity: {
      create: vi.fn().mockResolvedValue(identity()),
      findFirst: vi.fn().mockResolvedValue(identity()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirstOrThrow: vi.fn().mockResolvedValue(identity({ updatedAt: nextRevision })),
    },
  }
  const client = {
    $transaction: vi.fn(async (operation: (transaction: typeof tx) => unknown) => operation(tx)),
  }
  return { tx, client }
}

describe('staged AgentIdentity configuration actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    writeAudit.mockResolvedValue(undefined)
  })

  it('creates only a disabled, provider-free identity in an exact tenant venue', async () => {
    const { tx, client } = harness()
    await createDisabledAgentIdentity(
      { scope: venueScope, fields: { ...fields }, actor },
      client as never,
    )

    expect(tx.venue.findFirst).toHaveBeenCalledWith({
      where: { id: 'venue_1', tenantId: 'tenant_1' },
      select: { id: true },
    })
    expect(tx.agentIdentity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          accessScope: 'VENUE',
          enabled: false,
          defaultProvider: null,
          defaultModel: null,
        }),
      }),
    )
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.agent-identity.created-disabled' }),
      tx,
    )
  })

  it('does not create or audit through a mismatched tenant/venue boundary', async () => {
    const { tx, client } = harness()
    tx.venue.findFirst.mockResolvedValue(null)
    await expect(
      createDisabledAgentIdentity(
        { scope: venueScope, fields: { ...fields }, actor },
        client as never,
      ),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    } satisfies Partial<AgentIdentityConfigurationError>)
    expect(tx.agentIdentity.create).not.toHaveBeenCalled()
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('normalizes a nonexistent client scope before create and a raced FK loss during create', async () => {
    const missing = harness()
    missing.tx.tenant.findFirst.mockResolvedValue(null)
    await expect(
      createDisabledAgentIdentity(
        { scope: clientScope, fields: { ...fields }, actor },
        missing.client as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Client not found' })
    expect(missing.tx.agentIdentity.create).not.toHaveBeenCalled()
    expect(writeAudit).not.toHaveBeenCalled()

    const raced = harness()
    raced.tx.agentIdentity.create.mockRejectedValueOnce({ code: 'P2003' })
    await expect(
      createDisabledAgentIdentity(
        { scope: clientScope, fields: { ...fields }, actor },
        raced.client as never,
      ),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Client or venue no longer exists in the requested scope',
    })
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('rejects incoherent or free-form action authority before opening a transaction', async () => {
    const { client } = harness()
    await expect(
      createDisabledAgentIdentity(
        {
          scope: venueScope,
          fields: {
            ...fields,
            accessCapabilities: ['content.read'],
            autonomousActions: ['content.prepare-draft'],
          } as never,
          actor,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('edits only a disabled identity using exact client scope and revision CAS', async () => {
    const { tx, client } = harness()
    tx.agentIdentity.findFirst.mockResolvedValue(identity({ venueId: null, accessScope: 'CLIENT' }))
    tx.agentIdentity.findFirstOrThrow.mockResolvedValue(
      identity({ venueId: null, accessScope: 'CLIENT', updatedAt: nextRevision }),
    )
    await editDisabledAgentIdentity(
      {
        scope: clientScope,
        agentIdentityId: 'agent_1',
        expectedUpdatedAt: revision,
        fields: { ...fields },
        actor,
      },
      client as never,
    )
    expect(tx.agentIdentity.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'agent_1', tenantId: 'tenant_1', venueId: null } }),
    )
    expect(tx.agentIdentity.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'agent_1',
          tenantId: 'tenant_1',
          venueId: null,
          enabled: false,
          updatedAt: revision,
        },
        data: expect.not.objectContaining({
          enabled: expect.anything(),
          defaultProvider: expect.anything(),
          defaultModel: expect.anything(),
        }),
      }),
    )
  })

  it('treats a cross-tenant or cross-venue edit target as absent', async () => {
    const { tx, client } = harness()
    tx.agentIdentity.findFirst.mockResolvedValue(null)
    await expect(
      editDisabledAgentIdentity(
        {
          scope: venueScope,
          agentIdentityId: 'agent_from_another_scope',
          expectedUpdatedAt: revision,
          fields: { ...fields },
          actor,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(tx.agentIdentity.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'agent_from_another_scope',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
        },
      }),
    )
    expect(tx.agentIdentity.updateMany).not.toHaveBeenCalled()
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it.each([
    ['stale revision', identity({ updatedAt: nextRevision })],
    ['enabled identity', identity({ enabled: true })],
  ])('rejects an edit of a %s without update or audit', async (_label, existing) => {
    const { tx, client } = harness()
    tx.agentIdentity.findFirst.mockResolvedValue(existing)
    await expect(
      editDisabledAgentIdentity(
        {
          scope: venueScope,
          agentIdentityId: 'agent_1',
          expectedUpdatedAt: revision,
          fields: { ...fields },
          actor,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.agentIdentity.updateMany).not.toHaveBeenCalled()
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('fails a lost update at the guarded update and never writes misleading audit evidence', async () => {
    const { tx, client } = harness()
    tx.agentIdentity.updateMany.mockResolvedValue({ count: 0 })
    await expect(
      editDisabledAgentIdentity(
        {
          scope: venueScope,
          agentIdentityId: 'agent_1',
          expectedUpdatedAt: revision,
          fields: { ...fields },
          actor,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('disables a legacy enabled identity with the same exact-scope CAS and strict audit', async () => {
    const { tx, client } = harness()
    tx.agentIdentity.findFirst.mockResolvedValue(identity({ enabled: true }))
    await disableAgentIdentity(
      { scope: venueScope, agentIdentityId: 'agent_1', expectedUpdatedAt: revision, actor },
      client as never,
    )
    expect(tx.agentIdentity.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'agent_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          enabled: true,
          updatedAt: revision,
        }),
        data: expect.objectContaining({ enabled: false }),
      }),
    )
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.agent-identity.disabled' }),
      tx,
    )
  })

  it('enables only a provider-configured identity with exact-scope CAS and strict audit', async () => {
    const { tx, client } = harness()
    tx.agentIdentity.findFirst.mockResolvedValue(
      identity({
        defaultProvider: 'anthropic',
        defaultModel: 'claude-sonnet-4-6',
      }),
    )
    tx.agentIdentity.findFirstOrThrow.mockResolvedValue(
      identity({
        defaultProvider: 'anthropic',
        defaultModel: 'claude-sonnet-4-6',
        enabled: true,
      }),
    )
    await enableAgentIdentity(
      { scope: venueScope, agentIdentityId: 'agent_1', expectedUpdatedAt: revision, actor },
      client as never,
    )
    expect(tx.agentIdentity.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          enabled: false,
          tenantId: 'tenant_1',
          venueId: 'venue_1',
        }),
        data: expect.objectContaining({ enabled: true }),
      }),
    )
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.agent-identity.enabled' }),
      tx,
    )
  })

  it('refuses to enable an identity without a provider and model', async () => {
    const { tx, client } = harness()
    await expect(
      enableAgentIdentity(
        { scope: venueScope, agentIdentityId: 'agent_1', expectedUpdatedAt: revision, actor },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(tx.agentIdentity.updateMany).not.toHaveBeenCalled()
  })

  it('propagates strict audit failure so the enclosing transaction cannot report success', async () => {
    const { client } = harness()
    writeAudit.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(
      createDisabledAgentIdentity(
        { scope: venueScope, fields: { ...fields }, actor },
        client as never,
      ),
    ).rejects.toThrow('audit unavailable')
  })
})
