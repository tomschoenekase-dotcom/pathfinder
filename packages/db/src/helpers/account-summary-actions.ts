import { createHash } from 'node:crypto'

import { parseVerifiedActorContext } from '@pathfinder/contracts/actor'
import type { VerifiedActorContext } from '@pathfinder/contracts/actor'

import { db } from '../client'
import { getCompactAccountContext } from './account-context'
import { writeAuditLogStrict } from './audit'

type AccountSummaryActionClient = Pick<typeof db, 'prospectOrganization' | '$transaction'>

export class AccountSummaryActionError extends Error {
  constructor(
    readonly code: 'FORBIDDEN' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'AccountSummaryActionError'
  }
}

function inputProjection(context: Awaited<ReturnType<typeof getCompactAccountContext>>) {
  return {
    identity: context.identity,
    contacts: context.contacts.items.map((contact) => ({
      id: contact.id,
      preferredCommunication: contact.preferredCommunication,
      suppressed: contact.suppressed,
    })),
    commercial: {
      planTier: context.commercial.planTier,
      billingStatus: context.commercial.billing?.status ?? null,
      opportunity: context.commercial.opportunity,
    },
    venues: context.operations.venues.map((venue) => ({
      id: venue.id,
      active: venue.active,
      onboarding: venue.onboarding,
      openSupportCount: venue.openSupportCount,
    })),
    openLoops: context.openLoops,
    commitments: context.commitments,
    warnings: context.warnings,
  }
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export async function refreshAccountSummaryAction(
  input: {
    clientId: string
    organizationId: string
    actor: VerifiedActorContext
  },
  client: AccountSummaryActionClient = db,
) {
  const actor = parseVerifiedActorContext(input.actor)
  if (actor.type === 'AGENT' && actor.capability !== 'account-summaries.refresh') {
    throw new AccountSummaryActionError(
      'FORBIDDEN',
      'Machine actor requires account-summaries.refresh',
    )
  }
  const context = await getCompactAccountContext(
    { clientId: input.clientId, organizationId: input.organizationId },
    client,
  )
  const sourceInputs = inputProjection(context)
  const inputDigest = digest(sourceInputs)
  const primaryContact = context.contacts.items.find(
    (contact) => contact.id === context.contacts.primaryContactId,
  )
  const openSupportCount = context.operations.venues.reduce(
    (total, venue) => total + venue.openSupportCount,
    0,
  )
  const summary = [
    `${context.identity.canonicalName} is an active Torchiko account with ${context.identity.venueCount} scoped venue(s).`,
    primaryContact
      ? `Primary contact is ${primaryContact.name ?? primaryContact.email ?? primaryContact.id}${primaryContact.preferredCommunication ? ` via ${primaryContact.preferredCommunication.toLowerCase()}` : ''}.`
      : 'No unsuppressed primary contact is currently available.',
    `${context.openLoops.length} open loop(s), ${context.commitments.length} open commitment(s), and ${openSupportCount} open support request(s).`,
    context.commercial.billing
      ? `Billing is ${context.commercial.billing.status.toLowerCase()}.`
      : 'No billing account is recorded.',
  ].join(' ')
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const current = await tx.accountSummary.findFirst({
      where: {
        organizationId: input.organizationId,
        tenantId: input.clientId,
        status: 'CURRENT',
      },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, inputDigest: true, summary: true },
    })
    if (current?.inputDigest === inputDigest) return { ...current, replayed: true }
    const latest = await tx.accountSummary.aggregate({
      where: { organizationId: input.organizationId },
      _max: { version: true },
    })
    if (current) {
      await tx.accountSummary.updateMany({
        where: { organizationId: input.organizationId, status: 'CURRENT' },
        data: { status: 'SUPERSEDED' },
      })
    }
    const created = await tx.accountSummary.create({
      data: {
        tenantId: input.clientId,
        organizationId: input.organizationId,
        version: (latest._max.version ?? 0) + 1,
        status: 'CURRENT',
        summary,
        sections: {
          primaryContactId: context.contacts.primaryContactId,
          venueCount: context.identity.venueCount,
          openLoopCount: context.openLoops.length,
          commitmentCount: context.commitments.length,
          openSupportCount,
          warningCount: context.warnings.length,
        },
        sourceInputs,
        inputDigest,
        confidence: 1,
        generatedByType: actor.type,
        generatedById: actor.actorId,
        ...(actor.modelProvider ? { modelProvider: actor.modelProvider } : {}),
        ...(actor.modelName ? { modelName: actor.modelName } : {}),
      },
      select: { id: true, version: true, inputDigest: true, summary: true },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.clientId,
        actor,
        action: 'account-summary.refreshed',
        targetType: 'AccountSummary',
        targetId: created.id,
        structuredReason: {
          organizationId: input.organizationId,
          previousSummaryId: current?.id ?? null,
          inputDigest,
        },
        beforeState: current ? { id: current.id, version: current.version } : {},
        afterState: { id: created.id, version: created.version },
      },
      tx,
    )
    return { ...created, replayed: false }
  })
}
