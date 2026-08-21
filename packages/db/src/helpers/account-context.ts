import {
  ACCOUNT_CONTEXT_COLLECTION_LIMITS,
  ACCOUNT_CONTEXT_TARGET_BYTES,
  AccountContextRequest,
} from '@pathfinder/contracts/company-brain'

import { db } from '../client'

export class AccountContextError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'PAYLOAD_TOO_LARGE',
    message: string,
  ) {
    super(message)
    this.name = 'AccountContextError'
  }
}

export type AccountContextClient = Pick<typeof db, 'prospectOrganization'>

function iso(value: Date | null | undefined) {
  return value?.toISOString() ?? null
}

function sortRecent<T extends { occurredAt: string }>(entries: T[], limit: number) {
  return entries
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .slice(0, limit)
}

/**
 * Level-0/1 account projection. The organization is selected only through an
 * active exact-tenant relationship, so platform CRM rows are never fetched and
 * filtered after the fact. Collections are bounded in the database query.
 */
export async function getCompactAccountContext(
  rawInput: AccountContextRequest,
  client: AccountContextClient = db,
) {
  const input = AccountContextRequest.parse(rawInput)
  const limits = ACCOUNT_CONTEXT_COLLECTION_LIMITS
  const organization = await client.prospectOrganization.findFirst({
    where: {
      ...(input.organizationId ? { id: input.organizationId } : {}),
      archivedAt: null,
      customerRelationships: {
        some: { tenantId: input.clientId, status: 'ACTIVE' },
      },
    },
    select: {
      id: true,
      canonicalName: true,
      organizationType: true,
      description: true,
      headquartersCity: true,
      headquartersRegion: true,
      headquartersCountry: true,
      relationshipTier: true,
      createdAt: true,
      updatedAt: true,
      contacts: {
        where: { archivedAt: null },
        orderBy: [{ doNotContact: 'asc' }, { updatedAt: 'desc' }],
        take: limits.contacts,
        select: {
          id: true,
          fullName: true,
          title: true,
          email: true,
          phone: true,
          preferredCommunication: true,
          doNotContact: true,
          suppressionReason: true,
          updatedAt: true,
        },
      },
      opportunity: {
        select: {
          id: true,
          stage: true,
          priority: true,
          ownerId: true,
          nextAction: true,
          nextActionAt: true,
          lostParkedReason: true,
          lastActivityAt: true,
          updatedAt: true,
        },
      },
      conversion: {
        select: { id: true, tenantId: true, venueId: true, convertedAt: true },
      },
      customerRelationships: {
        where: { tenantId: input.clientId, status: 'ACTIVE' },
        orderBy: { relationshipVersion: 'desc' },
        take: 1,
        select: {
          id: true,
          status: true,
          relationshipVersion: true,
          startedAt: true,
          updatedAt: true,
          tenant: {
            select: {
              id: true,
              name: true,
              status: true,
              planTier: true,
              billingAccount: {
                select: {
                  status: true,
                  billingMode: true,
                  currency: true,
                  reconciliationHealth: true,
                  paidThroughAt: true,
                  gracePeriodEndsAt: true,
                  updatedAt: true,
                },
              },
              commercialAgreements: {
                where: { status: { in: ['ACTIVE', 'PENDING'] } },
                orderBy: { updatedAt: 'desc' },
                take: 5,
                select: {
                  id: true,
                  isBase: true,
                  internalPlanKey: true,
                  status: true,
                  billingMode: true,
                  billingInterval: true,
                  coveredVenueCount: true,
                  agreedAmountMinor: true,
                  currency: true,
                  startsAt: true,
                  currentPeriodEndsAt: true,
                  minimumCommitmentEndsAt: true,
                  cancelAtPeriodEnd: true,
                  updatedAt: true,
                },
              },
              venues: {
                ...(input.venueId ? { where: { id: input.venueId } } : {}),
                orderBy: { createdAt: 'asc' },
                take: limits.venues,
                select: {
                  id: true,
                  name: true,
                  category: true,
                  isActive: true,
                  secondLayerEnabled: true,
                  createdAt: true,
                  updatedAt: true,
                  intakeRuns: {
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                    select: { id: true, status: true, createdAt: true },
                  },
                  supportRequests: {
                    where: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
                    orderBy: { updatedAt: 'desc' },
                    take: 5,
                    select: {
                      id: true,
                      category: true,
                      status: true,
                      subject: true,
                      missingInformation: true,
                      createdAt: true,
                      updatedAt: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
      activities: {
        orderBy: { occurredAt: 'desc' },
        take: input.recentLimit,
        select: { id: true, type: true, summary: true, occurredAt: true },
      },
      emailMessages: {
        orderBy: { occurredAt: 'desc' },
        take: input.recentLimit,
        select: {
          id: true,
          direction: true,
          status: true,
          subject: true,
          contactId: true,
          occurredAt: true,
        },
      },
      companyMeetings: {
        orderBy: { startedAt: 'desc' },
        take: input.recentLimit,
        select: {
          id: true,
          title: true,
          meetingType: true,
          startedAt: true,
          summary: true,
          processingStatus: true,
        },
      },
      relationshipNotes: {
        where: {
          promotionStatus: 'PROMOTED',
          authority: { not: 'SUPERSEDED' },
          archivedAt: null,
          OR: [{ tenantId: null }, { tenantId: input.clientId }],
        },
        orderBy: [{ lastConfirmedAt: 'desc' }, { updatedAt: 'desc' }],
        take: limits.relationshipNotes,
        select: {
          id: true,
          category: true,
          body: true,
          authority: true,
          confidence: true,
          sourceType: true,
          sourceId: true,
          sourceRef: true,
          effectiveAt: true,
          lastConfirmedAt: true,
          updatedAt: true,
        },
      },
      milestones: {
        where: { OR: [{ tenantId: null }, { tenantId: input.clientId }] },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: limits.milestones,
        select: {
          id: true,
          type: true,
          summary: true,
          occurredAt: true,
          sourceType: true,
          sourceId: true,
          sourceRef: true,
        },
      },
      openLoops: {
        where: {
          status: { in: ['OPEN', 'BLOCKED'] },
          OR: [{ tenantId: null }, { tenantId: input.clientId }],
        },
        orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }],
        take: limits.openLoops,
        select: {
          id: true,
          title: true,
          summary: true,
          waitingOn: true,
          status: true,
          dueAt: true,
          ownerId: true,
          sourceType: true,
          sourceId: true,
          sourceRef: true,
          updatedAt: true,
        },
      },
      commitments: {
        where: {
          status: 'OPEN',
          OR: [{ tenantId: null }, { tenantId: input.clientId }],
        },
        orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }],
        take: limits.commitments,
        select: {
          id: true,
          party: true,
          statement: true,
          status: true,
          dueAt: true,
          ownerId: true,
          sourceType: true,
          sourceId: true,
          sourceRef: true,
          updatedAt: true,
        },
      },
      summaries: {
        where: { status: 'CURRENT', OR: [{ tenantId: null }, { tenantId: input.clientId }] },
        orderBy: { version: 'desc' },
        take: 1,
        select: {
          id: true,
          version: true,
          summary: true,
          sections: true,
          inputDigest: true,
          confidence: true,
          generatedByType: true,
          generatedById: true,
          modelProvider: true,
          modelName: true,
          updatedAt: true,
        },
      },
    },
  })
  if (!organization) {
    throw new AccountContextError('NOT_FOUND', 'Account not found in verified client scope')
  }
  const relationship = organization.customerRelationships[0]
  if (!relationship) {
    throw new AccountContextError('FORBIDDEN', 'No active account relationship in client scope')
  }
  const tenant = relationship.tenant
  if (input.venueId && tenant.venues.length === 0) {
    throw new AccountContextError('NOT_FOUND', 'Venue not found in verified account scope')
  }
  const summary = organization.summaries[0]
  const primaryContact = organization.contacts.find((contact) => !contact.doNotContact) ?? null
  const supportRequests = tenant.venues.flatMap((venue) =>
    venue.supportRequests.map((request) => ({
      ...request,
      venueId: venue.id,
      venueName: venue.name,
    })),
  )
  const recentActivity = sortRecent(
    [
      ...organization.activities.map((activity) => ({
        id: activity.id,
        kind: 'CRM_ACTIVITY' as const,
        summary: activity.summary,
        detail: activity.type,
        occurredAt: activity.occurredAt.toISOString(),
        provenance: { sourceType: 'OPERATIONAL_RECORD', sourceId: activity.id },
      })),
      ...organization.emailMessages.map((message) => ({
        id: message.id,
        kind: 'CORRESPONDENCE' as const,
        summary: message.subject,
        detail: `${message.direction}:${message.status}`,
        occurredAt: message.occurredAt.toISOString(),
        provenance: { sourceType: 'EMAIL', sourceId: message.id },
      })),
      ...organization.companyMeetings.map((meeting) => ({
        id: meeting.id,
        kind: 'MEETING' as const,
        summary: meeting.title,
        detail: meeting.summary ?? `${meeting.meetingType}:${meeting.processingStatus}`,
        occurredAt: meeting.startedAt.toISOString(),
        provenance: { sourceType: 'MEETING', sourceId: meeting.id },
      })),
      ...supportRequests.map((request) => ({
        id: request.id,
        kind: 'SUPPORT' as const,
        summary: request.subject,
        detail: `${request.status}:${request.category}`,
        occurredAt: request.updatedAt.toISOString(),
        provenance: { sourceType: 'SUPPORT_THREAD', sourceId: request.id },
      })),
    ],
    limits.recentActivity,
  )
  const warnings = [
    ...organization.contacts
      .filter((contact) => contact.doNotContact)
      .map((contact) => ({
        code: 'CONTACT_SUPPRESSED',
        severity: 'HIGH' as const,
        summary: `${contact.fullName ?? contact.email ?? contact.id} is suppressed`,
        sourceId: contact.id,
      })),
    ...(tenant.billingAccount && tenant.billingAccount.status !== 'ACTIVE'
      ? [
          {
            code: 'BILLING_ATTENTION',
            severity: 'HIGH' as const,
            summary: `Billing status is ${tenant.billingAccount.status}`,
            sourceId: input.clientId,
          },
        ]
      : []),
    ...supportRequests.map((request) => ({
      code: 'OPEN_SUPPORT',
      severity: request.status === 'AWAITING_APPROVAL' ? ('HIGH' as const) : ('NORMAL' as const),
      summary: request.subject,
      sourceId: request.id,
    })),
  ]

  const context = {
    schemaVersion: 'account-context.v1',
    generatedAt: new Date().toISOString(),
    freshness: {
      accountUpdatedAt: organization.updatedAt.toISOString(),
      relationshipUpdatedAt: relationship.updatedAt.toISOString(),
      summaryUpdatedAt: iso(summary?.updatedAt),
      summaryStatus: summary ? 'CURRENT' : 'MISSING',
    },
    identity: {
      organizationId: organization.id,
      canonicalName: organization.canonicalName,
      organizationType: organization.organizationType,
      lifecycle: organization.opportunity?.stage ?? 'CUSTOMER',
      clientStatus: relationship.status,
      relationshipTier: organization.relationshipTier,
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantStatus: tenant.status,
      venueCount: tenant.venues.length,
      primaryLocation: {
        city: organization.headquartersCity,
        region: organization.headquartersRegion,
        country: organization.headquartersCountry,
      },
      provenance: { kind: 'DETERMINISTIC', source: 'ProspectCustomerRelationship' },
    },
    relationship: {
      summary:
        summary?.summary ??
        `${organization.canonicalName} is an active Torchiko account with ${tenant.venues.length} scoped venue(s).`,
      summaryProvenance: summary
        ? {
            kind: 'MACHINE_DERIVED',
            sourceId: summary.id,
            version: summary.version,
            inputDigest: summary.inputDigest,
            confidence: summary.confidence,
            modelProvider: summary.modelProvider,
            modelName: summary.modelName,
          }
        : { kind: 'DETERMINISTIC_FALLBACK', sourceId: relationship.id },
      startedAt: relationship.startedAt.toISOString(),
      conversionAt: iso(organization.conversion?.convertedAt),
      notes: organization.relationshipNotes.map((note) => ({
        id: note.id,
        category: note.category,
        body: note.body,
        authority: note.authority,
        confidence: note.confidence,
        effectiveAt: iso(note.effectiveAt),
        lastConfirmedAt: iso(note.lastConfirmedAt),
        provenance: {
          sourceType: note.sourceType,
          sourceId: note.sourceId,
          sourceRef: note.sourceRef,
          updatedAt: note.updatedAt.toISOString(),
        },
      })),
    },
    contacts: {
      primaryContactId: primaryContact?.id ?? null,
      items: organization.contacts.map((contact) => ({
        id: contact.id,
        name: contact.fullName,
        role: contact.title,
        email: contact.email,
        phone: contact.phone,
        preferredCommunication: contact.preferredCommunication,
        suppressed: contact.doNotContact,
        suppressionReason: contact.suppressionReason,
        lastUpdatedAt: contact.updatedAt.toISOString(),
        provenance: { kind: 'DETERMINISTIC', source: 'ProspectContact' },
      })),
    },
    commercial: {
      planTier: tenant.planTier,
      billing: tenant.billingAccount
        ? {
            status: tenant.billingAccount.status,
            mode: tenant.billingAccount.billingMode,
            currency: tenant.billingAccount.currency,
            reconciliationHealth: tenant.billingAccount.reconciliationHealth,
            paidThroughAt: iso(tenant.billingAccount.paidThroughAt),
            gracePeriodEndsAt: iso(tenant.billingAccount.gracePeriodEndsAt),
            updatedAt: tenant.billingAccount.updatedAt.toISOString(),
          }
        : null,
      agreements: tenant.commercialAgreements.map((agreement) => ({
        id: agreement.id,
        isBase: agreement.isBase,
        planKey: agreement.internalPlanKey,
        status: agreement.status,
        billingMode: agreement.billingMode,
        interval: agreement.billingInterval,
        coveredVenueCount: agreement.coveredVenueCount,
        agreedAmountMinor: agreement.agreedAmountMinor?.toString() ?? null,
        currency: agreement.currency,
        startsAt: agreement.startsAt.toISOString(),
        currentPeriodEndsAt: iso(agreement.currentPeriodEndsAt),
        minimumCommitmentEndsAt: iso(agreement.minimumCommitmentEndsAt),
        cancelAtPeriodEnd: agreement.cancelAtPeriodEnd,
      })),
      opportunity: organization.opportunity
        ? {
            id: organization.opportunity.id,
            stage: organization.opportunity.stage,
            priority: organization.opportunity.priority,
            ownerId: organization.opportunity.ownerId,
            nextAction: organization.opportunity.nextAction,
            nextActionAt: iso(organization.opportunity.nextActionAt),
            lostParkedReason: organization.opportunity.lostParkedReason,
          }
        : null,
      provenance: { kind: 'DETERMINISTIC', sources: ['BillingAccount', 'CommercialAgreement'] },
    },
    operations: {
      venues: tenant.venues.map((venue) => ({
        id: venue.id,
        name: venue.name,
        category: venue.category,
        active: venue.isActive,
        secondLayerEnabled: venue.secondLayerEnabled,
        onboarding: venue.intakeRuns[0]
          ? {
              runId: venue.intakeRuns[0].id,
              status: venue.intakeRuns[0].status,
              updatedAt: venue.intakeRuns[0].createdAt.toISOString(),
            }
          : null,
        openSupportCount: venue.supportRequests.length,
        updatedAt: venue.updatedAt.toISOString(),
      })),
      openSupport: supportRequests.map((request) => ({
        id: request.id,
        venueId: request.venueId,
        venueName: request.venueName,
        category: request.category,
        status: request.status,
        subject: request.subject,
        missingInformation: request.missingInformation,
        updatedAt: request.updatedAt.toISOString(),
      })),
    },
    recentActivity,
    milestones: organization.milestones.map((milestone) => ({
      id: milestone.id,
      type: milestone.type,
      summary: milestone.summary,
      occurredAt: milestone.occurredAt.toISOString(),
      provenance: {
        sourceType: milestone.sourceType,
        sourceId: milestone.sourceId,
        sourceRef: milestone.sourceRef,
      },
    })),
    openLoops: organization.openLoops.map((loop) => ({
      id: loop.id,
      title: loop.title,
      summary: loop.summary,
      waitingOn: loop.waitingOn,
      status: loop.status,
      dueAt: iso(loop.dueAt),
      ownerId: loop.ownerId,
      provenance: {
        sourceType: loop.sourceType,
        sourceId: loop.sourceId,
        sourceRef: loop.sourceRef,
      },
    })),
    commitments: organization.commitments.map((commitment) => ({
      id: commitment.id,
      party: commitment.party,
      statement: commitment.statement,
      status: commitment.status,
      dueAt: iso(commitment.dueAt),
      ownerId: commitment.ownerId,
      provenance: {
        sourceType: commitment.sourceType,
        sourceId: commitment.sourceId,
        sourceRef: commitment.sourceRef,
      },
    })),
    warnings,
    next: {
      timeline: 'account.timeline',
      meetings: 'account.meetings',
      correspondence: 'account.correspondence',
      support: 'account.support',
      knowledgeSearch: 'knowledge.search',
    },
  }
  const approximateBytes = Buffer.byteLength(JSON.stringify(context), 'utf8')
  if (approximateBytes > ACCOUNT_CONTEXT_TARGET_BYTES * 2) {
    throw new AccountContextError(
      'PAYLOAD_TOO_LARGE',
      `Account context exceeded the hard ${ACCOUNT_CONTEXT_TARGET_BYTES * 2}-byte ceiling`,
    )
  }
  return {
    ...context,
    payload: {
      approximateBytes,
      targetBytes: ACCOUNT_CONTEXT_TARGET_BYTES,
      withinTarget: approximateBytes <= ACCOUNT_CONTEXT_TARGET_BYTES,
      collectionsBounded: true,
    },
  }
}
