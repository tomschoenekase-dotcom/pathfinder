import { describe, expect, it, vi } from 'vitest'
import { writeSourceClarificationAmendment } from './source-amendment-writer'
const input = {
  clientId: 'tenant',
  venueId: 'venue',
  agentRunId: 'agent-run',
  agentIdentityId: 'identity',
  runId: 'intake-run',
  receiptId: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
  expectedExtractedTextHash: 'a'.repeat(64),
  questionId: 'question',
  expectedAnsweredAt: '2030-01-01T00:00:00.000Z',
  kind: 'REPLACE_EXCERPT',
  amendedExcerpt: 'Two distinct buildings.',
  rationale: 'Retained answer clarifies identity.',
}
const context = {
  credential: {
    tenantId: 'tenant',
    clientId: 'tenant',
    credentialId: 'credential',
    venueIds: ['venue'],
    capabilities: ['intake:draft', 'intake-source:read', 'agent-runs:execute'],
  },
  executionClaim: {
    agentRunId: 'agent-run',
    workerId: 'worker',
    bridgeSessionId: 'session',
    executionLeaseToken: '33333333-3333-4333-8333-333333333333',
  },
}
function harness(replayed = false) {
  const tx = {
    agentWorkflowRunBinding: { findFirst: vi.fn().mockResolvedValue(null) },
    agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'identity' }) },
    intakeFileExtractionReceipt: { findFirst: vi.fn().mockResolvedValue({ id: input.receiptId }) },
    agentQuestion: { findFirst: vi.fn().mockResolvedValue({ id: 'question' }) },
  }
  const db = { $transaction: vi.fn(async (fn) => fn(tx)) }
  const claim = vi.fn().mockResolvedValue({ agentIdentityId: 'identity' })
  const resolve = vi.fn(async (locked, _input, options) => {
    expect(locked).toBe(tx)
    await options.admitResolution(locked)
    return {
      resolutionId: input.requestId,
      replayed,
      createdAt: new Date(),
      terminalReviewRequired: true,
    }
  })
  const audit = vi.fn().mockResolvedValue(undefined)
  const services = {
    assertCurrentAgentWorkerClaim: claim,
    resolveFileExtractionClarificationInTransaction: resolve,
    writeAuditLogStrict: audit,
  }
  const call = (raw: unknown = input, ctx: unknown = context) =>
    writeSourceClarificationAmendment(db as never, raw, ctx as never, services as never)
  return { tx, db, claim, resolve, audit, call }
}
describe('claimed source amendment writer', () => {
  it('binds identity, run and answer under admission and records bounded agent provenance', async () => {
    const h = harness()
    await h.call()
    expect(h.claim).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        requiredAgentType: 'CONTENT',
        requiredIdentityCapability: 'intake.read',
        requiredTransportCapabilities: context.credential.capabilities,
      }),
    )
    expect(h.tx.agentQuestion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          agentRunId: 'agent-run',
          agentIdentityId: 'identity',
          status: 'ANSWERED',
        }),
      }),
    )
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({
          type: 'AGENT',
          actorId: 'identity',
          workerId: 'worker',
          credentialId: 'credential',
        }),
      }),
      h.tx,
    )
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(input.amendedExcerpt)
  })
  it('revalidates admission on replay without duplicating audit', async () => {
    const h = harness(true)
    await h.call()
    expect(h.claim).toHaveBeenCalledOnce()
    expect(h.audit).not.toHaveBeenCalled()
  })
  it('rejects missing write grant, wrong run and caller actor injection before transaction', async () => {
    const h = harness()
    for (const grant of context.credential.capabilities)
      await expect(
        h.call(input, {
          ...context,
          credential: {
            ...context.credential,
            capabilities: context.credential.capabilities.filter((g) => g !== grant),
          },
        }),
      ).rejects.toThrow('unavailable')
    await expect(
      h.call(input, {
        ...context,
        executionClaim: { ...context.executionClaim, agentRunId: 'other' },
      }),
    ).rejects.toThrow('unavailable')
    await expect(h.call({ ...input, actorId: 'human' })).rejects.toThrow('unavailable')
    expect(h.db.$transaction).not.toHaveBeenCalled()
  })
  it('rejects selected workflow, missing draft identity and wrong question binding before write', async () => {
    for (const failure of ['binding', 'identity', 'question']) {
      const h = harness()
      if (failure === 'binding')
        h.tx.agentWorkflowRunBinding.findFirst.mockResolvedValue({ id: 'binding' } as never)
      if (failure === 'identity') h.tx.agentIdentity.findFirst.mockResolvedValue(null as never)
      if (failure === 'question') h.tx.agentQuestion.findFirst.mockResolvedValue(null as never)
      await expect(h.call()).rejects.toThrow('unavailable')
      expect(h.audit).not.toHaveBeenCalled()
    }
  })
  it('fails the enclosing transaction when provenance cannot be written', async () => {
    const h = harness()
    h.audit.mockRejectedValue(new Error('audit unavailable'))
    await expect(h.call()).rejects.toThrow('unavailable')
  })
})
