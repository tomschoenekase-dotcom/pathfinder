import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { linkProspectConversionAction } from '@pathfinder/db'

import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import type { OperatorKindContext, OperatorProposalKind } from '../proposals'
import { prospectOrganizationVersion } from './crm-stage-change'

const input = OPERATOR_MCP_INPUTS['customers.propose_link_existing']
type Args = ReturnType<typeof input.parse>

async function authorize(args: Args, context: OperatorKindContext) {
  // CRM relationships can expose customer correspondence; tenant-only grants cannot make them.
  if (!context.grant.allTenants) throw new OperatorNotFoundError()
  await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
  const location = await context.database.prospectVenue.findFirst({
    where: {
      id: args.prospectVenueId,
      organizationId: args.organizationId,
      organization: { archivedAt: null },
    },
    select: { id: true },
  })
  if (!location) throw new OperatorNotFoundError()
}

async function readLink(args: Args, context: OperatorKindContext) {
  return context.database.prospectLocationConversion.findFirst({
    where: {
      tenantId: args.tenantId,
      prospectVenueId: args.prospectVenueId,
      venueId: args.venueId,
      status: 'ACTIVE',
      relationship: {
        organizationId: args.organizationId,
        tenantId: args.tenantId,
        status: 'ACTIVE',
      },
    },
    select: { id: true, relationshipId: true },
  })
}

function outcome(args: Args, link: { id: string; relationshipId: string }, replayed: boolean) {
  const result = {
    organizationId: args.organizationId,
    prospectVenueId: args.prospectVenueId,
    tenantId: args.tenantId,
    venueId: args.venueId,
    relationshipId: link.relationshipId,
    locationConversionId: link.id,
    replayed,
    summary: 'CRM linked to the existing customer and venue; no customer or venue created.',
  }
  return { result, after: result as JsonValue }
}

export const customersLinkExistingKind: OperatorProposalKind<Args> = {
  kind: 'customers.link-existing',
  tool: 'customers.propose_link_existing',
  capability: 'customers:propose',
  parse: (raw) => input.parse(raw),
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId, ref: args.organizationId }),
  authorize,
  targetVersion: async (args) => String(args.expectedVersion),
  currentVersion: async (args, context) => {
    // An already established exact link is a state no-op, including recovery after a lost response.
    if (await readLink(args, context)) return String(args.expectedVersion)
    const version = await prospectOrganizationVersion(context.database, args.organizationId)
    return version === null ? null : String(version)
  },
  describe: (args) => ({
    title: 'Link an existing customer and venue to a reviewed CRM account',
    lines: [
      `CRM account: ${args.organizationId}`,
      `CRM location: ${args.prospectVenueId}`,
      `Existing customer: ${args.tenantId}`,
      `Existing venue: ${args.venueId}`,
    ],
  }),
  snapshot: async (args, context) => (await readLink(args, context)) as JsonValue,
  reconcile: async (args, context) => {
    const link = await readLink(args, context)
    if (!link) return { state: 'not_applied' }
    const [otherRelationship, otherLocation, legacyConflict] = await Promise.all([
      context.database.prospectCustomerRelationship.findFirst({
        where: {
          status: 'ACTIVE',
          OR: [
            { organizationId: args.organizationId, tenantId: { not: args.tenantId } },
            { tenantId: args.tenantId, organizationId: { not: args.organizationId } },
          ],
        },
        select: { id: true },
      }),
      context.database.prospectLocationConversion.findFirst({
        where: {
          tenantId: args.tenantId,
          status: 'ACTIVE',
          OR: [
            { prospectVenueId: args.prospectVenueId, venueId: { not: args.venueId } },
            { venueId: args.venueId, prospectVenueId: { not: args.prospectVenueId } },
          ],
        },
        select: { id: true },
      }),
      context.database.prospectConversion.findFirst({
        where: {
          OR: [
            { organizationId: args.organizationId, tenantId: { not: args.tenantId } },
            { tenantId: args.tenantId, organizationId: { not: args.organizationId } },
            { prospectVenueId: args.prospectVenueId, venueId: { not: args.venueId } },
            { venueId: args.venueId, prospectVenueId: { not: args.prospectVenueId } },
          ],
        },
        select: { id: true },
      }),
    ])
    if (otherRelationship || otherLocation || legacyConflict) return { state: 'unknown' }
    return { state: 'applied', outcome: outcome(args, link, true) }
  },
  apply: async (args, context) => {
    await authorize(args, context)
    const linked = await linkProspectConversionAction(
      {
        organizationId: args.organizationId,
        prospectVenueId: args.prospectVenueId,
        tenantId: args.tenantId,
        venueId: args.venueId,
        existingLink: { expectedVersion: args.expectedVersion },
        evidence: { operatorProposalId: context.proposalId, operationId: context.operationId },
        actor: context.actor,
      },
      context.database,
    )
    if (!linked.locationConversion) throw new Error('The CRM location link was not recorded')
    return outcome(
      args,
      { id: linked.locationConversion.id, relationshipId: linked.relationship.id },
      linked.replayed,
    )
  },
}
