import { describe, expect, it, vi } from 'vitest'

import {
  completeCompanyMeetingProcessingAction,
  ingestCompanyMeetingAction,
  recordCompanyMeetingExtractionAction,
} from './company-meeting-actions'

const machineActor = {
  type: 'AGENT',
  actorId: 'agent_1',
  role: 'AGENT',
  agentIdentityId: 'agent_1',
  agentRunId: 'run_1',
  workerId: 'worker_1',
  credentialId: 'credential_1',
  capability: 'meetings.process',
  modelProvider: 'hermes',
  modelName: 'worker-default',
} as const

function harness() {
  const tx = {
    venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue_1' }) },
    prospectOrganization: { findFirst: vi.fn().mockResolvedValue({ id: 'org_1' }) },
    prospectOpportunity: { findFirst: vi.fn().mockResolvedValue({ id: 'opportunity_1' }) },
    companyMeeting: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'meeting_1', processingStatus: 'RECEIVED' }),
      update: vi.fn(),
    },
    companyMeetingExtraction: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'extraction_1', promotionStatus: 'CANDIDATE' }),
    },
    accountSummary: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  const client = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  }
  return { tx, client: client as never }
}

describe('company meeting pipeline actions', () => {
  it('ingests an external meeting idempotently with scoped participants and source reference', async () => {
    const { tx, client } = harness()
    const result = await ingestCompanyMeetingAction(
      {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        organizationId: 'org_1',
        externalProvider: 'google-meet',
        externalId: 'meet_1',
        title: 'Museum Y review',
        meetingType: 'CLIENT_REVIEW',
        startedAt: new Date('2030-01-01T12:00:00.000Z'),
        sourceArtifactRef: 'drive://transcript_1',
        transcriptStatus: 'RETAINED_EXTERNALLY',
        participants: [{ contactId: 'contact_1', displayName: 'Jane Curator' }],
        idempotencyKey: 'google-meet:meet_1',
        actor: {
          type: 'INTEGRATION',
          actorId: 'google-workspace',
          role: 'INTEGRATION',
          integrationId: 'google-workspace',
        },
      },
      client,
    )
    expect(result.processingStatus).toBe('RECEIVED')
    expect(tx.companyMeeting.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          transcriptStatus: 'RETAINED_EXTERNALLY',
          participants: { create: [expect.objectContaining({ contactId: 'contact_1' })] },
        }),
      }),
    )
  })

  it('records extracted claims as candidates instead of silently promoting them', async () => {
    const { tx, client } = harness()
    tx.companyMeeting.findFirst.mockResolvedValue({
      id: 'meeting_1',
      tenantId: 'tenant_1',
      organizationId: 'org_1',
      processingStatus: 'PROCESSING',
    })
    await recordCompanyMeetingExtractionAction(
      {
        meetingId: 'meeting_1',
        tenantId: 'tenant_1',
        type: 'CLIENT_PREFERENCE',
        content: 'Jane prefers concise operational email.',
        confidence: 0.93,
        idempotencyKey: 'meeting_1:preference:1',
        actor: machineActor,
      },
      client,
    )
    expect(tx.companyMeetingExtraction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          promotionStatus: 'CANDIDATE',
          createdByType: 'AGENT',
          modelProvider: 'hermes',
        }),
      }),
    )
  })

  it('completes processing with durable provenance and machine audit lineage', async () => {
    const { tx, client } = harness()
    tx.companyMeeting.findFirst.mockResolvedValue({
      id: 'meeting_1',
      tenantId: 'tenant_1',
      organizationId: 'org_1',
      processingStatus: 'PROCESSING',
    })
    tx.companyMeeting.update.mockResolvedValue({
      id: 'meeting_1',
      tenantId: 'tenant_1',
      processingStatus: 'COMPLETE',
    })
    await completeCompanyMeetingProcessingAction(
      {
        meetingId: 'meeting_1',
        tenantId: 'tenant_1',
        summary: 'Reviewed launch readiness and next steps.',
        provenance: { extractionIds: ['extraction_1'] },
        actor: machineActor,
      },
      client,
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'company-meeting.processing-completed',
          actorType: 'AGENT',
          workerId: 'worker_1',
        }),
      }),
    )
    expect(tx.accountSummary.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', status: 'CURRENT' },
      data: { status: 'STALE' },
    })
  })
})
