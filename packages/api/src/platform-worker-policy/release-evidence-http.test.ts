import { describe, expect, it, vi } from 'vitest'

import { handlePlatformWorkerReleaseEvidenceRequest } from './release-evidence-http'

const secret = `pf_platform_${'a'.repeat(43)}`
const assessment = {
  schemaVersion: 1,
  generatedAt: '2026-08-25T04:01:22.858Z',
  revision: 'a'.repeat(40),
  profile: 'candidate',
  readiness: 'ready-for-staging-review',
  repository: { clean: true },
  summary: { passed: 1, failed: 0, blocked: 0 },
  gates: [{ id: 'typecheck', status: 'pass', durationMs: 100 }],
  limitations: ['Hosted behavior remains unproven.'],
  rollback: {
    application: 'Redeploy the last admitted staging revision.',
    database: 'Repair forward.',
    runbook: 'docs/staging-release-workflow.md',
  },
}
const request = (body: unknown, token = secret) =>
  new Request('http://localhost/api/platform-worker/release-evidence', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('platform worker release evidence HTTP boundary', () => {
  it('reads bounded evidence with a separately gated capability and strict audit', async () => {
    const verify = vi.fn().mockResolvedValue({
      credentialId: 'credential-1',
      workerId: 'release-worker',
      capabilities: ['release-evidence:read'],
    })
    const read = vi.fn().mockResolvedValue({
      current: { revision: assessment.revision },
      items: [{ revision: assessment.revision }],
      boundaries: { evidenceOnly: true },
    })
    const audit = vi.fn()
    const response = await handlePlatformWorkerReleaseEvidenceRequest(
      request({ action: 'read', limit: 5 }),
      { verify, read, audit },
    )
    expect(response.status).toBe(200)
    expect(verify).toHaveBeenCalledWith(secret, 'release-evidence:read')
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'release-evidence:read', actorType: 'AGENT' }),
    )
  })

  it('records evidence without receiving deployment authority', async () => {
    const verify = vi.fn().mockResolvedValue({
      credentialId: 'credential-1',
      workerId: 'release-worker',
      capabilities: ['release-evidence:record'],
    })
    const record = vi.fn().mockResolvedValue({ id: 'evidence-1', replayed: false })
    const response = await handlePlatformWorkerReleaseEvidenceRequest(
      request({
        action: 'record',
        operationId: '11111111-1111-4111-8111-111111111111',
        assessment,
        stagingHandoff: null,
        sourceReference: 'artifact://release/assessment.json',
      }),
      { verify, record },
    )
    expect(response.status).toBe(201)
    expect(verify).toHaveBeenCalledWith(secret, 'release-evidence:record')
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({
          type: 'AGENT',
          credentialId: 'credential-1',
          capability: 'release-evidence:record',
        }),
      }),
    )
  })

  it('rejects customer credentials and internally inconsistent reports', async () => {
    const verify = vi.fn()
    const customer = await handlePlatformWorkerReleaseEvidenceRequest(
      request({ action: 'read', limit: 5 }, `pf_mcp_${'a'.repeat(43)}`),
      { verify },
    )
    expect(customer.status).toBe(401)
    expect(verify).not.toHaveBeenCalled()

    const invalid = await handlePlatformWorkerReleaseEvidenceRequest(
      request({
        action: 'record',
        operationId: '11111111-1111-4111-8111-111111111111',
        assessment: { ...assessment, summary: { passed: 0, failed: 0, blocked: 0 } },
        stagingHandoff: null,
        sourceReference: 'artifact://release/assessment.json',
      }),
      { verify },
    )
    expect(invalid.status).toBe(400)
    expect(verify).not.toHaveBeenCalled()
  })
})
