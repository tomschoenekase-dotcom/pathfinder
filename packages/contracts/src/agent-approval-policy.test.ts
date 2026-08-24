import { describe, expect, it } from 'vitest'

import {
  defaultOperationalUpdateDraftPolicyConstraints,
  OperationalUpdateDraftPolicyConstraints,
  OperationalUpdateDraftPolicyParameters,
  defaultSupportRequestDraftPolicyConstraints,
  SupportRequestDraftPolicyConstraints,
  SupportRequestDraftPolicyParameters,
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
