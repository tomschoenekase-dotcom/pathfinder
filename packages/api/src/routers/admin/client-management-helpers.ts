import { createHash, randomUUID } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  ClientAccountActionError,
  ClientCreateIntentError,
  recordOrReplayOnboardingMilestoneEvent,
  type OnboardingMilestoneEventClient,
} from '@pathfinder/db'
import { ensureOrganizationInvitation } from '@pathfinder/auth'

import type { CreateVenueRequestInput } from '../../schemas/venue'

export const clientCreatePrimaryContactInput = z
  .object({
    emailAddress: z.string().trim().email(),
    role: z.enum(['org:admin', 'org:member']).default('org:admin'),
  })
  .optional()

export async function ensurePrimaryContactInvitation(input: {
  organizationId: string
  inviterUserId: string
  primaryContact?: { emailAddress: string; role: 'org:admin' | 'org:member' } | undefined
}) {
  return input.primaryContact
    ? ensureOrganizationInvitation({
        organizationId: input.organizationId,
        emailAddress: input.primaryContact.emailAddress,
        role: input.primaryContact.role,
        inviterUserId: input.inviterUserId,
      })
    : null
}

export async function recordPrimaryContactInvitationMilestone(input: {
  db: OnboardingMilestoneEventClient
  tenantId: string
  venueId: string
  requestId: string
  invitation: { id: string; replayed: boolean } | null
  actorId: string
  occurredAt: Date
}) {
  if (!input.invitation) return null
  return recordOrReplayOnboardingMilestoneEvent({
    db: input.db,
    input: {
      id: randomUUID(),
      tenantId: input.tenantId,
      venueId: input.venueId,
      eventType: 'INVITATION_STARTED',
      idempotencyKey: `client-create:${input.requestId}:invitation`,
      occurredAt: input.occurredAt,
      actorType: 'OPERATOR',
      actorId: input.actorId,
      sourceType: 'ORGANIZATION_INVITATION',
      sourceId: input.invitation.id,
    },
  })
}

export function platformAdminActor(userId: string) {
  return { type: 'HUMAN', id: userId, role: 'PLATFORM_ADMIN' } as const
}

export function clientCreateHash(input: {
  clientName: string
  clientSlug?: string | undefined
  primaryContact?: { emailAddress: string; role: 'org:admin' | 'org:member' } | undefined
  prospectConversion?: { organizationId: string; prospectVenueId?: string | undefined } | undefined
  venue: z.infer<typeof CreateVenueRequestInput>
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

export function mapClientCreateIntentError(error: unknown): never {
  if (error instanceof ClientCreateIntentError) {
    throw new TRPCError({ code: 'CONFLICT', message: error.message })
  }
  throw error
}

export function mapClientActionError(error: unknown): never {
  if (error instanceof ClientAccountActionError) {
    throw new TRPCError({
      code:
        error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'CONFLICT'
            ? 'CONFLICT'
            : 'BAD_REQUEST',
      message: error.message,
    })
  }
  throw error
}
