import { createHash } from 'node:crypto'

import {
  OnboardingMilestoneIdentity,
  type OnboardingMilestoneActorType,
  type OnboardingMilestoneEventType,
} from '@pathfinder/contracts'
import { canonicalEvaluationJson, type CanonicalJsonValue } from '@pathfinder/contracts/evaluation'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

type StoredMilestone = {
  id: string
  tenantId: string
  venueId: string
  eventType: string
  eventVersion: number
  idempotencyKey: string
  identityHash: string
  occurredAt: Date
  actorType: string
  actorId: string | null
  sourceType: string
  sourceId: string
  sourceRevision: string | null
  category: string | null
  durationMs: number | null
}

export type OnboardingMilestoneEventClient = {
  onboardingMilestoneEvent: {
    findFirst(args: unknown): Promise<StoredMilestone | null>
    create(args: unknown): Promise<StoredMilestone>
  }
}

export type RecordOnboardingMilestoneInput = {
  id: string
  tenantId: string
  venueId: string
  eventType: OnboardingMilestoneEventType
  idempotencyKey: string
  occurredAt: Date
  actorType: OnboardingMilestoneActorType
  actorId: string | null
  sourceType: string
  sourceId: string
  sourceRevision?: string | null
  category?: string | null
  durationMs?: number | null
}

export class OnboardingMilestoneEventError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'REPLAY_CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'OnboardingMilestoneEventError'
  }
}

function normalized(input: RecordOnboardingMilestoneInput) {
  if (!UUID_PATTERN.test(input.id)) {
    throw new OnboardingMilestoneEventError('INVALID_INPUT', 'Milestone id must be a UUID')
  }
  if (!input.tenantId.trim() || !input.venueId.trim()) {
    throw new OnboardingMilestoneEventError('INVALID_INPUT', 'Milestone scope must not be blank')
  }
  const parsed = OnboardingMilestoneIdentity.safeParse({
    eventType: input.eventType,
    eventVersion: 1,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt.toISOString(),
    actorType: input.actorType,
    actorId: input.actorId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision ?? null,
    category: input.category ?? null,
    durationMs: input.durationMs ?? null,
  })
  if (!parsed.success)
    throw new OnboardingMilestoneEventError('INVALID_INPUT', 'Milestone identity is invalid')
  return parsed.data
}

export function onboardingMilestoneIdentityHash(input: RecordOnboardingMilestoneInput): string {
  const identity = normalized(input)
  return createHash('sha256')
    .update(
      canonicalEvaluationJson({
        version: 'torchiko-onboarding-milestone-identity-v1',
        tenantId: input.tenantId,
        venueId: input.venueId,
        ...identity,
      } as CanonicalJsonValue),
      'utf8',
    )
    .digest('hex')
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

function assertReplay(row: StoredMilestone, identityHash: string): void {
  if (row.identityHash !== identityHash) {
    throw new OnboardingMilestoneEventError(
      'REPLAY_CONFLICT',
      'Milestone idempotency key was reused with a different immutable identity',
    )
  }
}

export async function recordOrReplayOnboardingMilestoneEvent(params: {
  db: OnboardingMilestoneEventClient
  input: RecordOnboardingMilestoneInput
}): Promise<{ event: StoredMilestone; replayed: boolean }> {
  const identity = normalized(params.input)
  const identityHash = onboardingMilestoneIdentityHash(params.input)
  const where = {
    tenantId: params.input.tenantId,
    venueId: params.input.venueId,
    eventType: identity.eventType,
    idempotencyKey: identity.idempotencyKey,
  }
  const existing = await params.db.onboardingMilestoneEvent.findFirst({ where })
  if (existing) {
    assertReplay(existing, identityHash)
    return { event: existing, replayed: true }
  }

  try {
    const event = await params.db.onboardingMilestoneEvent.create({
      data: {
        id: params.input.id,
        tenantId: params.input.tenantId,
        venueId: params.input.venueId,
        ...identity,
        occurredAt: params.input.occurredAt,
        identityHash,
      },
    })
    return { event, replayed: false }
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    const raced = await params.db.onboardingMilestoneEvent.findFirst({ where })
    if (!raced) throw error
    assertReplay(raced, identityHash)
    return { event: raced, replayed: true }
  }
}
