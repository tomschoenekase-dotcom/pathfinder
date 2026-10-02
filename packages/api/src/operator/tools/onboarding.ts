import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { operatorUntrustedText } from '../crm-projection'
import { assertTenantInGrant, OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'

const VENUE_CAP = 50

/**
 * One call that answers "where is this customer in onboarding?" from the canonical tables, with
 * no onboarding state of its own. Every number is a count of rows that already exist, so it cannot
 * drift from the portal or the admin app, and nothing here changes anything.
 */
const customersGetOnboarding: OperatorReadTool = {
  name: 'customers.get_onboarding',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['customers.get_onboarding'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    const database = context.database
    const tenantId = input.tenantId

    const tenant = await database.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, slug: true, status: true, planTier: true, createdAt: true },
    })
    if (!tenant) throw new OperatorNotFoundError()

    const [
      conversion,
      activeMembers,
      allMembers,
      venues,
      venueTotal,
      submissions,
      awaitingReview,
      packageGroups,
      pendingBlocking,
      routedUnanswered,
      supportOpen,
      supportWaiting,
    ] = await Promise.all([
      database.prospectConversion.findFirst({
        where: { tenantId },
        select: { organizationId: true, prospectVenueId: true, venueId: true, convertedAt: true },
      }),
      database.tenantMembership.count({ where: { tenantId, status: 'ACTIVE' } }),
      database.tenantMembership.count({ where: { tenantId } }),
      database.venue.findMany({
        where: { tenantId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: VENUE_CAP,
        select: {
          id: true,
          name: true,
          slug: true,
          isActive: true,
          updatedAt: true,
          _count: { select: { places: true, knowledgeEntries: true } },
        },
      }),
      database.venue.count({ where: { tenantId } }),
      database.intakeV1Submission.count({ where: { tenantId } }),
      database.intakeV1Submission.count({
        where: { tenantId, status: 'AWAITING_CANONICAL_REVIEW' },
      }),
      database.venuePackage.groupBy({
        by: ['status'],
        where: { tenantId },
        _count: { _all: true },
      }),
      database.agentQuestion.count({
        where: { tenantId, status: 'PENDING', blocking: true },
      }),
      database.onboardingQuestionLink.count({ where: { tenantId, resumedAt: null } }),
      database.supportRequest.count({ where: { tenantId, status: 'OPEN' } }),
      database.supportRequest.count({ where: { tenantId, status: 'WAITING_FOR_CLIENT' } }),
    ])

    const packageCount = (status: string) =>
      packageGroups.find((group) => group.status === status)?._count._all ?? 0
    const packages = {
      draft: packageCount('DRAFT'),
      reviewed: packageCount('APPROVED'),
      applied: packageCount('APPLIED'),
      reverted: packageCount('REVERTED'),
    }
    const live = venues.filter((venue) => venue.isActive).length

    const gaps: string[] = []
    if (activeMembers === 0) gaps.push('No active member can sign in yet.')
    if (venueTotal === 0) gaps.push('No venue exists yet.')
    else if (live === 0 && venues.length === venueTotal)
      gaps.push('No venue is live; every venue is still a draft.')
    if (venues.some((venue) => venue._count.knowledgeEntries === 0))
      gaps.push('At least one venue has no knowledge entries.')
    if (awaitingReview > 0) gaps.push(`${awaitingReview} intake submission(s) await review.`)
    if (packages.draft > 0) gaps.push(`${packages.draft} package draft(s) are not yet reviewed.`)
    if (packages.reviewed > 0)
      gaps.push(`${packages.reviewed} reviewed package(s) are not yet applied.`)
    if (pendingBlocking > 0) gaps.push(`${pendingBlocking} blocking question(s) are pending.`)
    if (routedUnanswered > 0)
      gaps.push(`${routedUnanswered} question(s) sent to the customer are unanswered.`)
    if (supportWaiting > 0) gaps.push(`${supportWaiting} support request(s) wait on the customer.`)
    if (!conversion) gaps.push('This account is not linked to a CRM account.')

    return {
      tenantId: tenant.id,
      name: operatorUntrustedText(tenant.name),
      slug: tenant.slug,
      status: tenant.status,
      planTier: tenant.planTier,
      createdAt: tenant.createdAt.toISOString(),
      prospectConversion: conversion
        ? {
            organizationId: conversion.organizationId,
            prospectVenueId: conversion.prospectVenueId,
            venueId: conversion.venueId,
            convertedAt: conversion.convertedAt.toISOString(),
          }
        : null,
      members: { active: activeMembers, other: allMembers - activeMembers },
      venues: venues.map((venue) => ({
        venueId: venue.id,
        name: operatorUntrustedText(venue.name),
        slug: venue.slug,
        live: venue.isActive,
        places: venue._count.places,
        knowledgeEntries: venue._count.knowledgeEntries,
        updatedAt: venue.updatedAt.toISOString(),
      })),
      venuesComplete: venueTotal <= VENUE_CAP,
      intake: { submissions, awaitingReview },
      packages,
      questions: { pendingBlocking, routedToCustomerUnanswered: routedUnanswered },
      support: { open: supportOpen, waitingForCustomer: supportWaiting },
      gaps: gaps.slice(0, 12),
    }
  },
}

export const onboardingReadTools: readonly OperatorReadTool[] = [customersGetOnboarding]
