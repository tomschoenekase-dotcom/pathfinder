export const CUSTOMER_STATE_PRESERVATION_CONTEXT_VERSION = 1 as const

export type CustomerStatePreservationPlanEvidence = {
  id: string
  status:
    | 'REQUESTED'
    | 'REVIEWED'
    | 'REVOCATION_SCHEDULED'
    | 'REVOKING'
    | 'EXPORT_READY'
    | 'COMPLETED'
    | 'CANCELLED'
  updatedAt: Date
  revocationEvidenceCount: number
  completedRevocationCount: number
  exportArtifactCount: number
} | null

export type CustomerStatePreservationVenueEvidence = {
  id: string
  name: string
  isActive: boolean
  placeRecordCount: number
  knowledgeRecordCount: number
  packageRecordCount: number
  manifestRecordCount: number
  hasBotConfigurationRecord: boolean
  latestPlan: CustomerStatePreservationPlanEvidence
}

export type CustomerStatePreservationInput = {
  tenantId: string
  tenantStatus: 'ACTIVE' | 'SUSPENDED' | 'TRIAL'
  billingStatus:
    | 'UNCONFIGURED'
    | 'PENDING'
    | 'ACTIVE'
    | 'PAST_DUE'
    | 'UNPAID'
    | 'CANCELED'
    | 'ENDED'
    | 'PAUSED'
    | 'MANUAL_REVIEW'
    | null
  venues: readonly CustomerStatePreservationVenueEvidence[]
  evidenceBounded: boolean
  now?: Date
}

export type CustomerStatePreservationContext = ReturnType<
  typeof buildCustomerStatePreservationContext
>

const ACTIVE_OFFBOARDING_STATES = new Set([
  'REQUESTED',
  'REVIEWED',
  'REVOCATION_SCHEDULED',
  'REVOKING',
  'EXPORT_READY',
])
const INACTIVE_BILLING_STATES = new Set(['CANCELED', 'ENDED', 'PAUSED'])

function nonNegative(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 0
}

/**
 * Describes preserved customer state for a future human reactivation review.
 *
 * It never chooses retention, creates a fee, restores access, contacts a customer,
 * or treats historical offboarding evidence as proof that current service is inactive.
 */
export function buildCustomerStatePreservationContext(input: CustomerStatePreservationInput) {
  const generatedAt = input.now ?? new Date()
  const billingInactive = input.billingStatus
    ? INACTIVE_BILLING_STATES.has(input.billingStatus)
    : false
  const venues = input.venues
    .map((venue) => {
      const plan = venue.latestPlan
      const activeOffboarding = Boolean(plan && ACTIVE_OFFBOARDING_STATES.has(plan.status))
      const currentServiceActive =
        venue.isActive && input.tenantStatus === 'ACTIVE' && !billingInactive && !activeOffboarding
      const material = {
        venueRecordPreserved: true as const,
        placeRecordCount: nonNegative(venue.placeRecordCount),
        knowledgeRecordCount: nonNegative(venue.knowledgeRecordCount),
        packageRecordCount: nonNegative(venue.packageRecordCount),
        manifestRecordCount: nonNegative(venue.manifestRecordCount),
        botConfigurationRecordPreserved: venue.hasBotConfigurationRecord,
        exportArtifactCount: nonNegative(plan?.exportArtifactCount ?? 0),
      }
      const operationalMaterialPreserved =
        material.placeRecordCount > 0 ||
        material.knowledgeRecordCount > 0 ||
        material.packageRecordCount > 0 ||
        material.manifestRecordCount > 0 ||
        material.botConfigurationRecordPreserved ||
        material.exportArtifactCount > 0
      const restorationEvidence = Boolean(
        plan && (plan.status === 'COMPLETED' || plan.completedRevocationCount > 0),
      )
      const reviewState = activeOffboarding
        ? ('OFFBOARDING_REVIEW' as const)
        : currentServiceActive
          ? ('ACTIVE_SERVICE' as const)
          : restorationEvidence
            ? ('RESTORATION_REVIEW' as const)
            : operationalMaterialPreserved
              ? ('PRESERVED_STATE' as const)
              : ('LIMITED_EVIDENCE' as const)
      const reviewReasons = [
        ...(activeOffboarding ? ['ACTIVE_OFFBOARDING_PLAN'] : []),
        ...(!venue.isActive ? ['VENUE_INACTIVE'] : []),
        ...(input.tenantStatus !== 'ACTIVE' ? ['TENANT_INACTIVE'] : []),
        ...(billingInactive ? ['BILLING_INACTIVE'] : []),
        ...(restorationEvidence ? ['REVOCATION_RESTORATION_REVIEW'] : []),
        ...(!operationalMaterialPreserved ? ['LIMITED_OPERATIONAL_MATERIAL'] : []),
      ] as Array<
        | 'ACTIVE_OFFBOARDING_PLAN'
        | 'VENUE_INACTIVE'
        | 'TENANT_INACTIVE'
        | 'BILLING_INACTIVE'
        | 'REVOCATION_RESTORATION_REVIEW'
        | 'LIMITED_OPERATIONAL_MATERIAL'
      >

      return {
        venueId: venue.id,
        venueName: venue.name,
        reviewState,
        currentServiceActive,
        operationalMaterialPreserved,
        material,
        latestOffboardingPlan: plan,
        reviewReasons,
      }
    })
    .sort(
      (left, right) =>
        left.venueName.localeCompare(right.venueName) || left.venueId.localeCompare(right.venueId),
    )

  return {
    schemaVersion:
      `torchiko-customer-state-preservation-v${CUSTOMER_STATE_PRESERVATION_CONTEXT_VERSION}` as const,
    generatedAt,
    tenantId: input.tenantId,
    tenantStatus: input.tenantStatus,
    billingStatus: input.billingStatus,
    evidenceBounded: input.evidenceBounded,
    policy: {
      automaticReactivationAuthorized: false as const,
      automaticCustomerContactAuthorized: false as const,
      retentionPolicy: 'UNRESOLVED' as const,
      pauseFeePolicy: 'UNRESOLVED' as const,
      reactivationFeePolicy: 'UNRESOLVED' as const,
    },
    summary: {
      venueCount: venues.length,
      activeServiceCount: venues.filter((venue) => venue.reviewState === 'ACTIVE_SERVICE').length,
      preservedStateCount: venues.filter((venue) => venue.reviewState === 'PRESERVED_STATE').length,
      restorationReviewCount: venues.filter((venue) => venue.reviewState === 'RESTORATION_REVIEW')
        .length,
      offboardingReviewCount: venues.filter((venue) => venue.reviewState === 'OFFBOARDING_REVIEW')
        .length,
      limitedEvidenceCount: venues.filter((venue) => venue.reviewState === 'LIMITED_EVIDENCE')
        .length,
    },
    venues,
    recommendedNextStep:
      'Review current access, billing, preserved material, and historical revocation evidence before any reactivation decision.',
  }
}
