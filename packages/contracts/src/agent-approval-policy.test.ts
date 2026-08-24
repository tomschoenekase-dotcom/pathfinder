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
  defaultSupportInternalNotePolicyConstraints,
  SupportInternalNotePolicyConstraints,
  SupportInternalNotePolicyParameters,
} from './agent-approval-policy'

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
