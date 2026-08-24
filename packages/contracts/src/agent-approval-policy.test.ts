import { describe, expect, it } from 'vitest'

import {
  defaultIntakeNotesProposalPolicyConstraints,
  IntakeNotesProposalPolicyConstraints,
  IntakeNotesProposalPolicyParameters,
  defaultOperationalUpdateDraftPolicyConstraints,
  OperationalUpdateDraftPolicyConstraints,
  OperationalUpdateDraftPolicyParameters,
  defaultSupportRequestDraftPolicyConstraints,
  SupportRequestDraftPolicyConstraints,
  SupportRequestDraftPolicyParameters,
  defaultSupportRequestOpenPolicyConstraints,
  SupportRequestOpenPolicyConstraints,
  SupportRequestOpenPolicyParameters,
  SupportTriageApplyParameters,
  SupportTriageProposalApprovalSnapshot,
  SupportInformationRequestApplyParameters,
  SupportInformationRequestProposalApprovalSnapshot,
  SupportCompletionApplyParameters,
  SupportCompletionProposalApprovalSnapshot,
  SupportPackageApprovalApplyParameters,
  SupportPackageApprovalProposalSnapshot,
  SupportPackageApplicationApplyParameters,
  SupportPackageApplicationProposalSnapshot,
  SupportPackageReversionApplyParameters,
  SupportPackageReversionProposalSnapshot,
  defaultSupportInternalNotePolicyConstraints,
  SupportInternalNotePolicyConstraints,
  SupportInternalNotePolicyParameters,
} from './agent-approval-policy'

describe('support completion fulfillment contract', () => {
  const packageFulfillment = {
    contractVersion: 1 as const,
    linkedPackageCount: 1,
    packages: [
      {
        handoffId: 'handoff_1',
        packageId: 'package_1',
        handoffRequestVersion: 4,
        status: 'APPLIED' as const,
        payloadHash: 'a'.repeat(64),
        appliedAt: '2030-01-02T00:00:00.000Z',
        appliedBy: 'agent_1',
        appliedCommandKey: '11111111-1111-4111-8111-111111111111',
        packageUpdatedAt: '2030-01-02T00:00:01.000Z',
      },
    ],
    digest: 'b'.repeat(64),
  }

  it('requires exact fully applied package evidence in the grant and proposal snapshot', () => {
    const parameters = {
      clientId: 'tenant_1',
      venueId: 'venue_1',
      requestId: 'request_1',
      expectedVersion: 5,
      fromStatus: 'IN_REVIEW' as const,
      toStatus: 'COMPLETED' as const,
      body: 'Your requested update is complete.',
      packageFulfillment,
    }
    expect(SupportCompletionApplyParameters.parse(parameters)).toEqual(parameters)
    const snapshot = {
      contractVersion: 2 as const,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      requestId: 'request_1',
      expectedVersion: 5,
      fromStatus: 'IN_REVIEW' as const,
      toStatus: 'COMPLETED' as const,
      body: parameters.body,
      missingInformationCount: 0 as const,
      packageFulfillment,
      allLinkedPackagesApplied: true as const,
      supportRequestChanged: false as const,
      clientActivityChanged: false as const,
      clientVisibleMessageCreated: false as const,
      customerContacted: false as const,
      externalDeliveryTriggered: false as const,
      executionAuthorized: false as const,
    }
    expect(SupportCompletionProposalApprovalSnapshot.parse(snapshot)).toEqual(snapshot)
    expect(() =>
      SupportCompletionApplyParameters.parse({
        ...parameters,
        packageFulfillment: { ...packageFulfillment, linkedPackageCount: 0 },
      }),
    ).toThrow()
  })
})

describe('support package approval authority contract', () => {
  const parameters = {
    clientId: 'tenant_1',
    venueId: 'venue_1',
    packageId: 'package_1',
    expectedUpdatedAt: '2030-01-01T00:00:00.000Z',
    payloadHash: 'a'.repeat(64),
    baseDigest: 'b'.repeat(64),
    warningDigest: 'c'.repeat(64),
    supportHandoff: {
      handoffId: 'handoff_1',
      supportRequestId: 'request_1',
      supportRequestVersion: 4,
    },
  }

  it('admits only one exact support-linked DRAFT-to-APPROVED transition', () => {
    expect(SupportPackageApprovalApplyParameters.parse(parameters)).toEqual(parameters)
    expect(() =>
      SupportPackageApprovalApplyParameters.parse({ ...parameters, apply: true }),
    ).toThrow()
  })

  it('records evaluation evidence without inventing a quality threshold', () => {
    const snapshot = {
      contractVersion: 1 as const,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      packageId: 'package_1',
      expectedUpdatedAt: parameters.expectedUpdatedAt,
      fromStatus: 'DRAFT' as const,
      toStatus: 'APPROVED' as const,
      payloadHash: parameters.payloadHash,
      baseDigest: parameters.baseDigest,
      warningDigest: parameters.warningDigest,
      warningCodes: ['DUPLICATE_EXISTING_CONTENT'],
      supportHandoff: parameters.supportHandoff,
      evaluationEvidence: {
        exactPackageRunIds: ['77777777-7777-4777-8777-777777777777'],
        truncated: false,
        thresholdApplied: false as const,
      },
      packageApproved: false as const,
      packageApplied: false as const,
      packagePublished: false as const,
      supportRequestChanged: false as const,
      customerContacted: false as const,
      externalDeliveryTriggered: false as const,
      executionAuthorized: false as const,
    }
    expect(SupportPackageApprovalProposalSnapshot.parse(snapshot)).toEqual(snapshot)
    expect(() =>
      SupportPackageApprovalProposalSnapshot.parse({
        ...snapshot,
        evaluationEvidence: { ...snapshot.evaluationEvidence, thresholdApplied: true },
      }),
    ).toThrow()
  })
})

describe('support package application authority contract', () => {
  const parameters = {
    clientId: 'tenant_1',
    venueId: 'venue_1',
    packageId: 'package_1',
    expectedUpdatedAt: '2030-01-02T00:00:00.000Z',
    payloadHash: 'a'.repeat(64),
    baseDigest: 'b'.repeat(64),
    warningDigest: 'c'.repeat(64),
    approvedAt: '2030-01-01T00:00:00.000Z',
    approvedBy: 'founder_1',
    supportHandoff: {
      handoffId: 'handoff_1',
      supportRequestId: 'request_1',
      supportRequestVersion: 4,
    },
  }

  it('freezes exactly one approved package without bundling completion or revert authority', () => {
    expect(SupportPackageApplicationApplyParameters.parse(parameters)).toEqual(parameters)
    expect(() =>
      SupportPackageApplicationApplyParameters.parse({ ...parameters, completeSupport: true }),
    ).toThrow()
  })

  it('makes current and potentially visitor-visible mutation explicit', () => {
    const snapshot = {
      contractVersion: 1 as const,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      packageId: 'package_1',
      expectedUpdatedAt: parameters.expectedUpdatedAt,
      fromStatus: 'APPROVED' as const,
      toStatus: 'APPLIED' as const,
      payloadHash: parameters.payloadHash,
      baseDigest: parameters.baseDigest,
      warningDigest: parameters.warningDigest,
      warningCodes: [],
      approvedAt: parameters.approvedAt,
      approvedBy: parameters.approvedBy,
      supportHandoff: parameters.supportHandoff,
      evaluationEvidence: {
        exactPackageRunIds: [],
        truncated: false,
        thresholdApplied: false as const,
      },
      currentContentMutation: true as const,
      visitorVisibleChangePossible: true as const,
      supportRequestChanged: false as const,
      customerContacted: false as const,
      externalDeliveryTriggered: false as const,
      supportCompletionTriggered: false as const,
      revertTriggered: false as const,
      executionAuthorized: false as const,
    }
    expect(SupportPackageApplicationProposalSnapshot.parse(snapshot)).toEqual(snapshot)
    expect(() =>
      SupportPackageApplicationProposalSnapshot.parse({
        ...snapshot,
        visitorVisibleChangePossible: false,
      }),
    ).toThrow()
  })
})

describe('support package reversion authority contract', () => {
  const parameters = {
    clientId: 'tenant_1',
    venueId: 'venue_1',
    packageId: 'package_1',
    expectedUpdatedAt: '2030-01-02T00:00:00.000Z',
    payloadHash: 'a'.repeat(64),
    baseDigest: 'b'.repeat(64),
    rollbackManifestDigest: 'c'.repeat(64),
    appliedAt: '2030-01-01T00:00:00.000Z',
    appliedBy: 'agent_1',
    appliedCommandKey: '88888888-8888-4888-8888-888888888888',
    supportHandoff: {
      handoffId: 'handoff_1',
      supportRequestId: 'request_1',
      supportRequestVersion: 4,
    },
    supportRequestVersion: 6,
    supportRequestStatus: 'IN_REVIEW' as const,
  }

  it('freezes exact active-request and rollback evidence without reusable policy', () => {
    expect(SupportPackageReversionApplyParameters.parse(parameters)).toEqual(parameters)
    expect(() =>
      SupportPackageReversionApplyParameters.parse({
        ...parameters,
        supportRequestStatus: 'COMPLETED',
      }),
    ).toThrow()
  })

  it('requires canonical drift checks and keeps the proposal inert', () => {
    const snapshot = {
      contractVersion: 1 as const,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      packageId: parameters.packageId,
      expectedUpdatedAt: parameters.expectedUpdatedAt,
      fromStatus: 'APPLIED' as const,
      toStatus: 'REVERTED' as const,
      payloadHash: parameters.payloadHash,
      baseDigest: parameters.baseDigest,
      rollbackManifestDigest: parameters.rollbackManifestDigest,
      appliedAt: parameters.appliedAt,
      appliedBy: parameters.appliedBy,
      appliedCommandKey: parameters.appliedCommandKey,
      supportHandoff: parameters.supportHandoff,
      supportRequestVersion: parameters.supportRequestVersion,
      supportRequestStatus: parameters.supportRequestStatus,
      currentContentMutation: true as const,
      visitorVisibleChangePossible: true as const,
      canonicalDriftCheckRequired: true as const,
      automaticRollbackPolicyApplied: false as const,
      supportRequestChanged: false as const,
      customerContacted: false as const,
      externalDeliveryTriggered: false as const,
      executionAuthorized: false as const,
    }
    expect(SupportPackageReversionProposalSnapshot.parse(snapshot)).toEqual(snapshot)
    expect(() =>
      SupportPackageReversionProposalSnapshot.parse({
        ...snapshot,
        automaticRollbackPolicyApplied: true,
      }),
    ).toThrow()
  })
})

describe('operational update draft policy contract', () => {
  it('keeps the supported action class draft-only and bounded', () => {
    expect(
      OperationalUpdateDraftPolicyConstraints.parse(
        defaultOperationalUpdateDraftPolicyConstraints(),
      ),
    ).toEqual({
      contractVersion: 1,
      effect: 'DRAFT_ONLY',
      allowedUpdateTypes: ['GENERAL_NOTICE'],
      allowedSeverities: ['INFO'],
      allowedPriorities: ['NORMAL'],
      maxTitleChars: 160,
      maxBodyChars: 4000,
    })
    expect(() =>
      OperationalUpdateDraftPolicyConstraints.parse({
        ...defaultOperationalUpdateDraftPolicyConstraints(),
        effect: 'PUBLISH',
      }),
    ).toThrow()
  })

  it('requires a valid bounded draft window and rejects unknown authority-bearing fields', () => {
    const input = {
      clientId: 'tenant_1',
      venueId: 'venue_1',
      updateType: 'GENERAL_NOTICE' as const,
      severity: 'INFO' as const,
      priority: 'NORMAL' as const,
      title: 'Gallery note',
      body: 'The gallery is temporarily unavailable.',
      startsAt: '2030-01-01T12:00:00.000Z',
      expiresAt: '2030-01-01T13:00:00.000Z',
    }
    expect(OperationalUpdateDraftPolicyParameters.parse(input)).toEqual(input)
    expect(() =>
      OperationalUpdateDraftPolicyParameters.parse({ ...input, publish: true }),
    ).toThrow()
    expect(() =>
      OperationalUpdateDraftPolicyParameters.parse({
        ...input,
        expiresAt: '2030-01-01T11:00:00.000Z',
      }),
    ).toThrow()
  })
})

describe('support request draft policy contract', () => {
  it('permits only bounded internal draft parameters', () => {
    expect(
      SupportRequestDraftPolicyConstraints.parse(defaultSupportRequestDraftPolicyConstraints()),
    ).toMatchObject({
      contractVersion: 1,
      effect: 'DRAFT_ONLY',
      maxSubjectChars: 200,
      maxBodyChars: 20_000,
    })
    const parameters = {
      clientId: 'tenant_1',
      venueId: 'venue_1',
      category: 'GENERAL' as const,
      subject: 'Review visitor answer',
      body: 'Prepare an internal support review; do not contact the customer.',
    }
    expect(SupportRequestDraftPolicyParameters.parse(parameters)).toEqual(parameters)
    expect(() =>
      SupportRequestDraftPolicyParameters.parse({ ...parameters, customerVisible: true }),
    ).toThrow()
  })
})

describe('support request open policy contract', () => {
  it('permits only an exact DRAFT-to-OPEN lifecycle promotion', () => {
    expect(
      SupportRequestOpenPolicyConstraints.parse(defaultSupportRequestOpenPolicyConstraints()),
    ).toEqual({
      contractVersion: 1,
      effect: 'DRAFT_TO_OPEN_ONLY',
      allowedFromStatuses: ['DRAFT'],
      allowedToStatuses: ['OPEN'],
    })
    const parameters = {
      clientId: 'tenant_1',
      venueId: 'venue_1',
      requestId: 'request_1',
      expectedVersion: 1,
      fromStatus: 'DRAFT' as const,
      toStatus: 'OPEN' as const,
    }
    expect(SupportRequestOpenPolicyParameters.parse(parameters)).toEqual(parameters)
    expect(() =>
      SupportRequestOpenPolicyParameters.parse({ ...parameters, sendMessage: true }),
    ).toThrow()
  })
})

describe('support triage approval contract', () => {
  it('freezes one exact reviewed request version without communication or lifecycle authority', () => {
    const parameters = {
      clientId: 'tenant_1',
      venueId: 'venue_1',
      requestId: 'request_1',
      expectedVersion: 3,
      category: 'CONTENT_CORRECTION' as const,
      missingInformation: ['Current exhibit label photograph'],
    }
    expect(SupportTriageApplyParameters.parse(parameters)).toEqual(parameters)
    expect(() => SupportTriageApplyParameters.parse({ ...parameters, sendMessage: true })).toThrow()
    expect(
      SupportTriageProposalApprovalSnapshot.parse({
        contractVersion: 1,
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        requestId: 'request_1',
        expectedVersion: 3,
        proposedCategory: 'CONTENT_CORRECTION',
        proposedMissingInformation: ['Current exhibit label photograph'],
        supportRequestChanged: false,
        clientActivityChanged: false,
        customerContacted: false,
        executionAuthorized: false,
      }),
    ).toMatchObject({ requestId: 'request_1', expectedVersion: 3 })
  })
})

describe('support information-request approval contract', () => {
  it('freezes one exact client-visible prompt and lifecycle transition', () => {
    const parameters = {
      clientId: 'tenant_1',
      venueId: 'venue_1',
      requestId: 'request_1',
      expectedVersion: 3,
      fromStatus: 'IN_REVIEW' as const,
      toStatus: 'WAITING_FOR_CLIENT' as const,
      body: 'Please provide the current exhibit label photograph.',
      missingInformation: ['Current exhibit label photograph'],
    }
    expect(SupportInformationRequestApplyParameters.parse(parameters)).toEqual(parameters)
    expect(() =>
      SupportInformationRequestApplyParameters.parse({ ...parameters, email: true }),
    ).toThrow()
    expect(
      SupportInformationRequestProposalApprovalSnapshot.parse({
        contractVersion: 1,
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        requestId: 'request_1',
        expectedVersion: 3,
        fromStatus: 'IN_REVIEW',
        toStatus: 'WAITING_FOR_CLIENT',
        body: parameters.body,
        missingInformation: parameters.missingInformation,
        supportRequestChanged: false,
        clientActivityChanged: false,
        clientVisibleMessageCreated: false,
        customerContacted: false,
        externalDeliveryTriggered: false,
        executionAuthorized: false,
      }),
    ).toMatchObject({ requestId: 'request_1', customerContacted: false })
  })
})

describe('support internal note policy contract', () => {
  it('permits only one bounded internal-only attachment-free note', () => {
    expect(
      SupportInternalNotePolicyConstraints.parse(defaultSupportInternalNotePolicyConstraints()),
    ).toEqual({
      contractVersion: 1,
      effect: 'INTERNAL_NOTE_ONLY',
      allowedVisibilities: ['INTERNAL_ONLY'],
      maxAttachments: 0,
      maxBodyChars: 20_000,
    })
    const parameters = {
      clientId: 'tenant_1',
      venueId: 'venue_1',
      requestId: 'request_1',
      expectedVersion: 2,
      visibility: 'INTERNAL_ONLY' as const,
      body: 'Internal investigation context for the support team.',
      attachmentCount: 0 as const,
    }
    expect(SupportInternalNotePolicyParameters.parse(parameters)).toEqual(parameters)
    expect(() =>
      SupportInternalNotePolicyParameters.parse({ ...parameters, customerVisible: true }),
    ).toThrow()
  })
})

describe('intake notes proposal policy contract', () => {
  it('permits only bounded NOTES proposals that remain review-only', () => {
    expect(
      IntakeNotesProposalPolicyConstraints.parse(defaultIntakeNotesProposalPolicyConstraints()),
    ).toEqual({
      contractVersion: 1,
      effect: 'PROPOSAL_ONLY',
      allowedKinds: ['NOTES'],
      maxNotesChars: 20_000,
    })
    const parameters = {
      clientId: 'tenant_1',
      venueId: 'venue_1',
      kind: 'NOTES' as const,
      notes: 'Use these notes as private onboarding source material for human review.',
    }
    expect(IntakeNotesProposalPolicyParameters.parse(parameters)).toEqual(parameters)
    expect(() =>
      IntakeNotesProposalPolicyParameters.parse({ ...parameters, autoApply: true }),
    ).toThrow()
  })
})
