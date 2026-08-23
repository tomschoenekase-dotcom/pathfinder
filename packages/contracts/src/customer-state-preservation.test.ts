import { describe, expect, it } from 'vitest'

import {
  buildCustomerStatePreservationContext,
  type CustomerStatePreservationInput,
} from './customer-state-preservation'

function input(
  override: Partial<CustomerStatePreservationInput> = {},
): CustomerStatePreservationInput {
  return {
    tenantId: 'tenant-1',
    tenantStatus: 'ACTIVE',
    billingStatus: 'ACTIVE',
    evidenceBounded: false,
    now: new Date('2026-08-23T12:00:00.000Z'),
    venues: [
      {
        id: 'venue-1',
        name: 'Harbor Museum',
        isActive: false,
        placeRecordCount: 8,
        knowledgeRecordCount: 3,
        packageRecordCount: 2,
        manifestRecordCount: 1,
        hasBotConfigurationRecord: true,
        latestPlan: null,
      },
    ],
    ...override,
  }
}

describe('customer state preservation context', () => {
  it('describes paused preserved state without authorizing reactivation or inventing fees', () => {
    const context = buildCustomerStatePreservationContext(input())
    expect(context).toMatchObject({
      schemaVersion: 'torchiko-customer-state-preservation-v1',
      policy: {
        automaticReactivationAuthorized: false,
        automaticCustomerContactAuthorized: false,
        retentionPolicy: 'UNRESOLVED',
        pauseFeePolicy: 'UNRESOLVED',
        reactivationFeePolicy: 'UNRESOLVED',
      },
      summary: { preservedStateCount: 1 },
      venues: [
        {
          reviewState: 'PRESERVED_STATE',
          operationalMaterialPreserved: true,
          reviewReasons: ['VENUE_INACTIVE'],
        },
      ],
    })
  })

  it('keeps current active truth above completed historical offboarding evidence', () => {
    const context = buildCustomerStatePreservationContext(
      input({
        venues: [
          {
            ...input().venues[0]!,
            isActive: true,
            latestPlan: {
              id: 'old-plan',
              status: 'COMPLETED',
              updatedAt: new Date('2026-01-01T00:00:00.000Z'),
              revocationEvidenceCount: 2,
              completedRevocationCount: 2,
              exportArtifactCount: 1,
            },
          },
        ],
      }),
    )
    expect(context.venues[0]).toMatchObject({
      reviewState: 'ACTIVE_SERVICE',
      currentServiceActive: true,
      latestOffboardingPlan: { id: 'old-plan', status: 'COMPLETED' },
    })
  })

  it('gives a current offboarding plan precedence over otherwise active service', () => {
    const venue = input().venues[0]!
    const context = buildCustomerStatePreservationContext(
      input({
        venues: [
          {
            ...venue,
            isActive: true,
            latestPlan: {
              id: 'plan-1',
              status: 'EXPORT_READY',
              updatedAt: new Date('2026-08-22T00:00:00.000Z'),
              revocationEvidenceCount: 0,
              completedRevocationCount: 0,
              exportArtifactCount: 4,
            },
          },
        ],
      }),
    )
    expect(context.venues[0]).toMatchObject({
      reviewState: 'OFFBOARDING_REVIEW',
      currentServiceActive: false,
      reviewReasons: ['ACTIVE_OFFBOARDING_PLAN'],
    })
  })

  it('requires restoration review after completed revocation evidence', () => {
    const venue = input().venues[0]!
    const context = buildCustomerStatePreservationContext(
      input({
        billingStatus: 'ENDED',
        venues: [
          {
            ...venue,
            latestPlan: {
              id: 'plan-1',
              status: 'COMPLETED',
              updatedAt: new Date('2026-08-22T00:00:00.000Z'),
              revocationEvidenceCount: 3,
              completedRevocationCount: 2,
              exportArtifactCount: 4,
            },
          },
        ],
      }),
    )
    expect(context.venues[0]).toMatchObject({
      reviewState: 'RESTORATION_REVIEW',
      reviewReasons: ['VENUE_INACTIVE', 'BILLING_INACTIVE', 'REVOCATION_RESTORATION_REVIEW'],
    })
  })

  it('reports limited evidence instead of claiming a rebuild-ready venue', () => {
    const context = buildCustomerStatePreservationContext(
      input({
        venues: [
          {
            ...input().venues[0]!,
            placeRecordCount: 0,
            knowledgeRecordCount: 0,
            packageRecordCount: 0,
            manifestRecordCount: 0,
            hasBotConfigurationRecord: false,
          },
        ],
      }),
    )
    expect(context.venues[0]).toMatchObject({
      reviewState: 'LIMITED_EVIDENCE',
      operationalMaterialPreserved: false,
      reviewReasons: ['VENUE_INACTIVE', 'LIMITED_OPERATIONAL_MATERIAL'],
    })
  })
})
