import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ProspectContactabilityError } from '@pathfinder/db'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  createProspect: vi.fn(),
  beginImport: vi.fn(),
  deliveryControl: vi.fn(),
  providerAccounts: vi.fn(),
  followups: vi.fn(),
  prospect: vi.fn(),
  reviewContactReadiness: vi.fn(),
  prepareAttachmentRetention: vi.fn(),
  reviewAttachmentRetention: vi.fn(),
  reviewInboundReply: vi.fn(),
  onboardingAttempt: vi.fn(),
  addSourcedCampaignContact: vi.fn(),
  selectCampaignContactRoute: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  addSourcedProspectCampaignContactAction: mocks.addSourcedCampaignContact,
  PROSPECT_OUTREACH_MAX_BATCH: 500,
  PROSPECT_OUTREACH_MAX_COHORT: 5_000,
  PROSPECT_OUTREACH_RELEASE_POLICY: {
    phase: 'INITIAL_CANARY',
    maxRecipients: 50,
    nextPhase: 'EVALUATED_CANARY',
    nextPhaseMaxRecipients: 100,
    promotionStatus: 'NOT_AUTHORIZED',
    promotionRequirement: 'REVIEWED_EVIDENCE_AND_CODE_CHANGE',
  },
  ProspectActionError: class ProspectActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  ProspectContactabilityError: class ProspectContactabilityError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  withTenantIsolationBypass: mocks.bypass,
  createProspectAction: mocks.createProspect,
  selectProspectCampaignContactRouteAction: mocks.selectCampaignContactRoute,
  prepareProspectEmailAttachmentRetentionAction: mocks.prepareAttachmentRetention,
  reviewProspectEmailAttachmentRetentionAction: mocks.reviewAttachmentRetention,
  reviewProspectInboundReplyAction: mocks.reviewInboundReply,
  reviewProspectContactReadinessAction: mocks.reviewContactReadiness,
  beginProspectImportAction: mocks.beginImport,
  addProspectNoteAction: vi.fn(),
  approveProspectImportAction: vi.fn(),
  archiveProspectAction: vi.fn(),
  commitProspectImportBatchAction: vi.fn(),
  linkProspectConversionAction: vi.fn(),
  resolveProspectDuplicateAction: vi.fn(),
  resolveProspectImportRowAction: vi.fn(),
  scanProspectDuplicatesAction: vi.fn(),
  stageProspectImportRowsAction: vi.fn(),
  updateProspectPipelineAction: vi.fn(),
  db: {
    prospectDeliveryControl: { findUnique: mocks.deliveryControl },
    correspondenceProviderAccount: { findMany: mocks.providerAccounts },
    prospectFollowup: { findMany: mocks.followups },
    prospectOrganization: { findUnique: mocks.prospect },
    prospectOnboardingDeliveryAttempt: { findFirst: mocks.onboardingAttempt },
  },
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminProspectCrmRouter } from './prospect-crm'

const testRouter = router({ crm: adminProspectCrmRouter })

function context(isPlatformAdmin: boolean): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'operator_1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  }
}

describe('admin prospect CRM router', () => {
  beforeEach(() => vi.clearAllMocks())

  it('routes source-backed contact creation and contact selection through the admin actor', async () => {
    vi.stubEnv('CRM_PROSPECT_OUTREACH_ENABLED', 'true')
    mocks.addSourcedCampaignContact.mockResolvedValue({ id: 'contact-2' })
    mocks.selectCampaignContactRoute.mockResolvedValue({ changed: true })
    const caller = testRouter.createCaller(context(true)).crm
    await expect(
      caller.addSourcedProspectCampaignContact({
        memberId: 'member-1',
        email: 'info@venue.example',
        sourceEvidenceId: 'evidence-1',
        fullName: 'Venue inbox',
      }),
    ).resolves.toEqual({ id: 'contact-2' })
    await expect(
      caller.selectProspectCampaignContactRoute({ memberId: 'member-1', contactId: 'contact-2' }),
    ).resolves.toEqual({ changed: true })
    expect(mocks.addSourcedCampaignContact).toHaveBeenCalledWith({
      memberId: 'member-1',
      email: 'info@venue.example',
      sourceEvidenceId: 'evidence-1',
      fullName: 'Venue inbox',
      actor: { type: 'HUMAN', id: 'operator_1', role: 'PLATFORM_ADMIN' },
    })
    expect(mocks.selectCampaignContactRoute).toHaveBeenCalledWith({
      memberId: 'member-1',
      contactId: 'contact-2',
      actor: { type: 'HUMAN', id: 'operator_1', role: 'PLATFORM_ADMIN' },
    })
    vi.unstubAllEnvs()
  })

  it('reads an invitation draft only through its exact organization, venue, and message scope', async () => {
    mocks.onboardingAttempt.mockResolvedValueOnce({
      id: 'attempt-1',
      status: 'DRAFT',
      organizationId: 'org-1',
      prospectVenueId: 'venue-1',
      sourceMessageId: 'message-1',
      recipientEmailSnapshot: 'owner@example.com',
      subject: 'A private preview',
      textBody: 'Draft body',
      sourceMessage: {
        inboundReplyDisposition: 'POSITIVE_INTEREST',
        inboundReplyReviewId: 'review-current',
      },
    })
    const caller = testRouter.createCaller(context(true)).crm
    await expect(
      caller.getProspectOnboardingDeliveryAttempt({
        organizationId: 'org-1',
        prospectVenueId: 'venue-1',
        messageId: 'message-1',
      }),
    ).resolves.toMatchObject({
      id: 'attempt-1',
      status: 'DRAFT',
      currentReview: {
        id: 'review-current',
        disposition: 'POSITIVE_INTEREST',
        state: 'POSITIVE_INTEREST',
      },
      deliveryAuthorization: 'NOT_GRANTED_BY_DRAFT',
    })
    expect(mocks.onboardingAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          prospectVenueId: 'venue-1',
          sourceMessageId: 'message-1',
          sourceMessage: { organizationId: 'org-1', venueId: 'venue-1' },
        }),
      }),
    )

    mocks.onboardingAttempt.mockResolvedValueOnce(null)
    await expect(
      caller.getProspectOnboardingDeliveryAttempt({
        organizationId: 'org-1',
        prospectVenueId: 'wrong-venue',
        messageId: 'message-1',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it.each(['NOT_INTERESTED', 'SUPPRESSION_REQUEST', 'QUESTION_OR_OBJECTION', 'OTHER', null])(
    'holds retained invitation history after classification becomes %s',
    async (disposition) => {
      mocks.onboardingAttempt.mockResolvedValueOnce({
        id: 'attempt-1',
        status: 'DRAFT',
        sourceReviewId: 'original-positive-review',
        textBody: 'Original invitation',
        sourceMessage: { inboundReplyDisposition: disposition, inboundReplyReviewId: 'new-review' },
      })
      const result = await testRouter
        .createCaller(context(true))
        .crm.getProspectOnboardingDeliveryAttempt({
          organizationId: 'org-1',
          prospectVenueId: 'venue-1',
          messageId: 'message-1',
        })
      expect(result).toMatchObject({
        status: 'DRAFT',
        sourceReviewId: 'original-positive-review',
        textBody: 'Original invitation',
        currentReview: { id: 'new-review', disposition, state: 'HELD' },
        deliveryAuthorization: 'NOT_GRANTED_BY_DRAFT',
      })
      expect(result).not.toHaveProperty('sourceMessage')
    },
  )

  it('holds a positive classification without a current review receipt', async () => {
    mocks.onboardingAttempt.mockResolvedValueOnce({
      id: 'attempt-1',
      status: 'DRAFT',
      sourceMessage: { inboundReplyDisposition: 'POSITIVE_INTEREST', inboundReplyReviewId: null },
    })
    const result = await testRouter
      .createCaller(context(true))
      .crm.getProspectOnboardingDeliveryAttempt({
        organizationId: 'org-1',
        prospectVenueId: 'venue-1',
        messageId: 'message-1',
      })
    expect(result.currentReview.state).toBe('HELD')
  })

  it('rejects non-admin reads and writes before bypass or action dispatch', async () => {
    const caller = testRouter.createCaller(context(false)).crm
    await expect(caller.listProspects({ limit: 10 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    } satisfies Partial<TRPCError>)
    await expect(
      caller.createProspect({ organization: { canonicalName: 'Blocked prospect' } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>)
    await expect(
      caller.prepareProspectEmailAttachmentRetention({
        operationId: '11111111-1111-4111-8111-111111111111',
        emailMessageId: 'message-1',
        providerAttachmentId: 'attachment-1',
        category: 'CUSTOMER_KNOWLEDGE',
        purpose: 'Blocked request.',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>)
    await expect(
      caller.reviewProspectContactReadiness({
        contactId: 'contact-1',
        emailReadiness: 'VALID',
        permissionState: 'LEGITIMATE_INTEREST_RECORDED',
        evidence: 'Blocked review.',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>)
    await expect(
      caller.addSourcedProspectCampaignContact({
        memberId: 'member-1',
        email: 'info@venue.example',
        sourceEvidenceId: 'evidence-1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>)
    await expect(
      caller.selectProspectCampaignContactRoute({ memberId: 'member-1', contactId: 'contact-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>)
    expect(mocks.bypass).not.toHaveBeenCalled()
    expect(mocks.createProspect).not.toHaveBeenCalled()
    expect(mocks.prepareAttachmentRetention).not.toHaveBeenCalled()
    expect(mocks.reviewInboundReply).not.toHaveBeenCalled()
    expect(mocks.reviewContactReadiness).not.toHaveBeenCalled()
    expect(mocks.addSourcedCampaignContact).not.toHaveBeenCalled()
    expect(mocks.selectCampaignContactRoute).not.toHaveBeenCalled()
  })

  it('derives the human platform-admin actor from the authenticated session', async () => {
    mocks.createProspect.mockResolvedValue({
      organization: { id: 'prospect_1' },
      venue: null,
      contact: null,
    })
    const result = await testRouter
      .createCaller(context(true))
      .crm.createProspect({ organization: { canonicalName: 'Authorized prospect' } })
    expect(result.organization.id).toBe('prospect_1')
    expect(mocks.createProspect).toHaveBeenCalledWith({
      organization: { canonicalName: 'Authorized prospect' },
      actor: { type: 'HUMAN', id: 'operator_1', role: 'PLATFORM_ADMIN' },
    })
  })

  it('records bounded human contact-readiness evidence without granting delivery authority', async () => {
    mocks.reviewContactReadiness.mockResolvedValue({
      id: 'contact-1',
      emailReadiness: 'VALID',
      permissionState: 'LEGITIMATE_INTEREST_RECORDED',
    })

    const result = await testRouter.createCaller(context(true)).crm.reviewProspectContactReadiness({
      contactId: 'contact-1',
      emailReadiness: 'VALID',
      permissionState: 'LEGITIMATE_INTEREST_RECORDED',
      evidence: 'Public venue contact page reviewed by the operator.',
    })

    expect(result).toMatchObject({
      id: 'contact-1',
      emailReadiness: 'VALID',
      permissionState: 'LEGITIMATE_INTEREST_RECORDED',
    })
    expect(mocks.reviewContactReadiness).toHaveBeenCalledWith({
      contactId: 'contact-1',
      emailReadiness: 'VALID',
      permissionState: 'LEGITIMATE_INTEREST_RECORDED',
      evidence: {
        reviewReason: 'Public venue contact page reviewed by the operator.',
        interface: 'prospect_detail',
      },
      actor: { type: 'HUMAN', id: 'operator_1', role: 'PLATFORM_ADMIN' },
    })
  })

  it('rejects blank contact-readiness evidence before action dispatch', async () => {
    await expect(
      testRouter.createCaller(context(true)).crm.reviewProspectContactReadiness({
        contactId: 'contact-1',
        emailReadiness: 'VALID',
        permissionState: 'LEGITIMATE_INTEREST_RECORDED',
        evidence: '   ',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' } satisfies Partial<TRPCError>)
    expect(mocks.reviewContactReadiness).not.toHaveBeenCalled()
  })

  it('reports a terminal contact state as a failed precondition', async () => {
    mocks.reviewContactReadiness.mockRejectedValueOnce(
      new ProspectContactabilityError(
        'APPROVAL_REQUIRED',
        'Suppressed contacts cannot be returned to outreach readiness.',
      ),
    )

    await expect(
      testRouter.createCaller(context(true)).crm.reviewProspectContactReadiness({
        contactId: 'contact-1',
        emailReadiness: 'INVALID',
        permissionState: 'REVIEW_REQUIRED',
        evidence: 'Confirmed the existing terminal contact state.',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' } satisfies Partial<TRPCError>)
  })

  it('rejects oversized imports at the API boundary before action dispatch', async () => {
    await expect(
      testRouter.createCaller(context(true)).crm.beginProspectImport({
        fileName: 'oversized.xlsx',
        fileType: 'xlsx',
        fileSize: 25 * 1024 * 1024 + 1,
        fileHash: 'a'.repeat(64),
        mappingHash: 'b'.repeat(64),
        mapping: {},
        sheets: [{ sheetName: 'Data', sheetIndex: 0, detectedRows: 1, columns: [] }],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' } satisfies Partial<TRPCError>)
    expect(mocks.beginImport).not.toHaveBeenCalled()
  })

  it('returns bounded follow-up review evidence without granting scheduling or send authority', async () => {
    vi.stubEnv('CRM_PROSPECT_OUTREACH_ENABLED', 'true')
    mocks.deliveryControl.mockResolvedValue({ deliveryEnabled: false, internalOnly: true })
    mocks.providerAccounts.mockResolvedValue([])
    mocks.followups.mockResolvedValue([
      {
        id: 'followup-1',
        organizationId: 'org-1',
        dueAt: new Date('2020-01-01T00:00:00Z'),
        sequenceNumber: 1,
        status: 'PENDING',
        reason: 'Human-approved schedule',
        policyApprovedAt: new Date('2019-12-01T00:00:00Z'),
        readinessCheckedAt: null,
        organization: { canonicalName: 'Museum One', relationshipTier: 'HIGH_VALUE' },
        opportunity: { stage: 'CONTACTED', priority: 'HIGH', lastActivityAt: null },
        campaignMember: { status: 'CONTACTED' },
        triggerSendItem: { sentAt: new Date('2019-11-01T00:00:00Z') },
      },
    ])

    const result = await testRouter.createCaller(context(true)).crm.getProspectOutreachReadiness()

    expect(result.followupReview).toMatchObject({
      evidenceBounded: false,
      counts: { due: 1, scheduled: 0, readyForDraft: 0, held: 0 },
      policy: {
        automaticSchedulingAuthorized: false,
        automaticSendingAuthorized: false,
        alternateContactAuthorized: false,
        cadencePolicy: 'UNRESOLVED',
      },
    })
    expect(result.followupReview.items[0]).toMatchObject({
      id: 'followup-1',
      due: true,
      policyApproved: true,
    })
    expect(mocks.followups).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 101,
        where: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      }),
    )
    vi.unstubAllEnvs()
  })

  it('returns only compact correspondence previews and source references in prospect detail', async () => {
    mocks.prospect.mockResolvedValue({ customerRelationships: [], conversion: null })

    const result = await testRouter.createCaller(context(true)).crm.getProspect({
      organizationId: 'org-1',
    })

    expect(result).toEqual({ customerRelationships: [], conversion: null })
    const query = mocks.prospect.mock.calls[0]?.[0]
    const messageSelect = query?.include?.emailThreads?.include?.messages?.select
    expect(messageSelect).toMatchObject({
      bodyPreview: true,
      inboundReplyDisposition: true,
      inboundReplyReviewedAt: true,
      bodyRetentionState: true,
      sourceReference: true,
      attachmentMetadata: true,
    })
    expect(messageSelect.attachmentRetentionRequests.select).toMatchObject({
      providerAttachmentId: true,
      category: true,
      purpose: true,
      status: true,
      reviewReason: true,
    })
    expect(messageSelect.currentInboundReplyReview.select).toMatchObject({
      disposition: true,
      reason: true,
      reviewerId: true,
      revision: true,
    })
    expect(messageSelect).not.toHaveProperty('textBody')
    expect(messageSelect).not.toHaveProperty('htmlBody')
  })

  it('derives human authority for provider-dark attachment preparation and review', async () => {
    mocks.prepareAttachmentRetention.mockResolvedValue({ request: { id: 'request-1' } })
    mocks.reviewAttachmentRetention.mockResolvedValue({
      request: { id: 'request-1', status: 'APPROVED_FOR_IMPORT' },
    })
    const caller = testRouter.createCaller(context(true)).crm
    await caller.prepareProspectEmailAttachmentRetention({
      operationId: '11111111-1111-4111-8111-111111111111',
      emailMessageId: 'message-1',
      providerAttachmentId: 'attachment-1',
      category: 'FLOOR_PLAN_OR_MAP',
      purpose: 'Needed for the guide.',
    })
    await caller.reviewProspectEmailAttachmentRetention({
      requestId: '33333333-3333-4333-8333-333333333333',
      reviewOperationId: '22222222-2222-4222-8222-222222222222',
      decision: 'APPROVE_FOR_IMPORT',
      reason: 'Useful source material.',
    })

    const actor = { type: 'HUMAN', id: 'operator_1', role: 'PLATFORM_ADMIN' }
    expect(mocks.prepareAttachmentRetention).toHaveBeenCalledWith(
      expect.objectContaining({ actor }),
    )
    expect(mocks.reviewAttachmentRetention).toHaveBeenCalledWith(expect.objectContaining({ actor }))
  })

  it('derives human authority for explicit inbound reply classification', async () => {
    mocks.reviewInboundReply.mockResolvedValue({
      review: { id: 'review-1', disposition: 'POSITIVE_INTEREST' },
      replayed: false,
    })

    await testRouter.createCaller(context(true)).crm.reviewProspectInboundReply({
      operationId: '11111111-1111-4111-8111-111111111111',
      messageId: 'message-1',
      disposition: 'POSITIVE_INTEREST',
      reason: 'They asked to schedule a product conversation.',
    })

    expect(mocks.reviewInboundReply).toHaveBeenCalledWith({
      operationId: '11111111-1111-4111-8111-111111111111',
      messageId: 'message-1',
      disposition: 'POSITIVE_INTEREST',
      reason: 'They asked to schedule a product conversation.',
      actor: { type: 'HUMAN', id: 'operator_1', role: 'PLATFORM_ADMIN' },
    })
  })

  it('returns meeting transcript provenance metadata without transcript content', async () => {
    mocks.prospect.mockResolvedValue({ customerRelationships: [], conversion: null })

    await testRouter.createCaller(context(true)).crm.getProspect({ organizationId: 'org-1' })

    const query = mocks.prospect.mock.calls[0]?.[0]
    const artifactSelect = query?.include?.companyMeetings?.include?.transcriptArtifacts?.select
    expect(artifactSelect).toEqual({
      id: true,
      sourceReference: true,
      acquiredAt: true,
      expiresAt: true,
    })
    expect(artifactSelect).not.toHaveProperty('transcriptText')
    expect(artifactSelect).not.toHaveProperty('structuredEntries')
  })
})
