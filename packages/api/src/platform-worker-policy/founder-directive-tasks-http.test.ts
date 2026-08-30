import { describe, expect, it, vi } from 'vitest'

import { handlePlatformWorkerFounderDirectiveTasksRequest } from './founder-directive-tasks-http'

const secret = `pf_platform_${'a'.repeat(43)}`
const request = (body: unknown, token = secret) =>
  new Request('http://localhost/api/platform-worker/founder-directive-tasks', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const proposal = {
  action: 'propose' as const,
  operationId: '11111111-1111-4111-8111-111111111111',
  founderOperatingExchangeId: '22222222-2222-4222-8222-222222222222',
  expectedSnapshotHash: 'a'.repeat(64),
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  agentIdentityId: 'agent-1',
  proposedPrompt: 'Prepare the exact reviewed venue update.',
  rationale: 'The founder explicitly requested this bounded work.',
  riskCategory: 'MEDIUM' as const,
  constraints: ['Do not contact the customer.'],
}

describe('platform worker founder directive task HTTP boundary', () => {
  it('reads only with the dedicated read capability and strict audit', async () => {
    const verify = vi.fn().mockResolvedValue({
      credentialId: 'credential-1',
      workerId: 'edith-primary',
      capabilities: ['founder-directive-tasks:read'],
    })
    const read = vi
      .fn()
      .mockResolvedValue({ items: [], boundaries: { proposalIsExecution: false } })
    const audit = vi.fn()
    const response = await handlePlatformWorkerFounderDirectiveTasksRequest(
      request({ action: 'read', limit: 10, status: 'AWAITING_APPROVAL' }),
      { verify, read, audit },
    )
    expect(response.status).toBe(200)
    expect(verify).toHaveBeenCalledWith(secret, 'founder-directive-tasks:read')
    expect(read).toHaveBeenCalledWith({ limit: 10, status: 'AWAITING_APPROVAL' })
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'founder-directive-tasks:read', actorType: 'AGENT' }),
    )
  })

  it('creates only a review proposal with the proposal capability', async () => {
    const verify = vi.fn().mockResolvedValue({
      credentialId: 'credential-1',
      workerId: 'edith-primary',
      capabilities: ['founder-directive-tasks:propose'],
    })
    const propose = vi.fn().mockResolvedValue({
      request: { id: 'request-1', status: 'AWAITING_APPROVAL' },
      replayed: false,
    })
    const response = await handlePlatformWorkerFounderDirectiveTasksRequest(request(proposal), {
      verify,
      propose,
    })
    expect(response.status).toBe(201)
    expect(verify).toHaveBeenCalledWith(secret, 'founder-directive-tasks:propose')
    expect(propose).toHaveBeenCalledWith(
      expect.objectContaining({
        proposedPrompt: proposal.proposedPrompt,
        actor: {
          type: 'AGENT',
          id: 'edith-primary',
          credentialId: 'credential-1',
          capability: 'founder-directive-tasks:propose',
        },
      }),
    )
  })

  it('materializes and dispatches only through the separate exact capability', async () => {
    const verify = vi.fn().mockResolvedValue({
      credentialId: 'credential-1',
      workerId: 'edith-primary',
      capabilities: ['founder-directive-tasks:materialize'],
    })
    const materialize = vi.fn().mockResolvedValue({
      request: { id: '44444444-4444-4444-8444-444444444444', tenantId: 'tenant-1' },
      run: { id: 'run-1', status: 'QUEUED' },
      replayed: false,
    })
    const enqueue = vi.fn().mockResolvedValue({ enqueued: true })
    const response = await handlePlatformWorkerFounderDirectiveTasksRequest(
      request({
        action: 'materialize',
        operationId: '33333333-3333-4333-8333-333333333333',
        requestId: '44444444-4444-4444-8444-444444444444',
        expectedApprovalDecisionId: 'decision-1',
      }),
      { verify, materialize, enqueue },
    )
    expect(response.status).toBe(201)
    expect(verify).toHaveBeenCalledWith(secret, 'founder-directive-tasks:materialize')
    expect(enqueue).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', runId: 'run-1' },
      expect.objectContaining({ enabled: expect.any(Boolean) }),
    )
    expect(await response.json()).toMatchObject({ executionTriggered: true })
  })

  it('rejects customer credentials and malformed scope before verification', async () => {
    const verify = vi.fn()
    const customer = await handlePlatformWorkerFounderDirectiveTasksRequest(
      request({ action: 'read' }, `pf_mcp_${'a'.repeat(43)}`),
      { verify },
    )
    expect(customer.status).toBe(401)
    const invalid = await handlePlatformWorkerFounderDirectiveTasksRequest(
      request({ ...proposal, constraints: ['same', 'same'] }),
      { verify },
    )
    expect(invalid.status).toBe(400)
    expect(verify).not.toHaveBeenCalled()
  })
})
