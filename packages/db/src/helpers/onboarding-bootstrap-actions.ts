import { createHash } from 'node:crypto'
import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { setContentVersionContext } from './content-version-context'
import { normalizeVenueSlug, venueCreateSelect } from './venue-create-action'

export type OnboardingBootstrapActor = {
  type: 'HUMAN'
  id: string
  role: 'OWNER' | 'MANAGER'
}
export type OnboardingBootstrapClient = Pick<typeof db, '$transaction' | 'intakeRun' | 'venue'>

export class OnboardingBootstrapError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'CONFLICT' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'OnboardingBootstrapError'
  }
}

const rawContent = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('place'),
      value: z
        .object({
          name: z.string().trim().min(1).max(255),
          type: z.string().trim().min(1).max(100),
          shortDescription: z.string().trim().min(1).max(2_000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('knowledge'),
      value: z
        .object({
          title: z.string().trim().min(1).max(255),
          category: z.string().trim().min(1).max(100),
          content: z.string().trim().min(1).max(10_000),
        })
        .strict(),
    })
    .strict(),
])

export const onboardingBootstrapSubmissionInput = z
  .object({
    requestId: z.string().uuid(),
    venue: z
      .object({
        name: z.string().trim().min(1).max(255),
        slug: z.string().trim().min(1).max(200),
        category: z.string().trim().min(1).max(100).optional(),
        guideMode: z.enum(['location_aware', 'non_location']),
        defaultCenterLat: z.number().finite().min(-90).max(90).optional(),
        defaultCenterLng: z.number().finite().min(-180).max(180).optional(),
      })
      .strict()
      .superRefine((venue, context) => {
        const hasBoth = venue.defaultCenterLat !== undefined && venue.defaultCenterLng !== undefined
        if (venue.guideMode === 'location_aware' && !hasBoth) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Location-aware venues require a center.',
          })
        }
        if (
          venue.guideMode === 'non_location' &&
          (venue.defaultCenterLat !== undefined || venue.defaultCenterLng !== undefined)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Non-location venues cannot include a center.',
          })
        }
      }),
    rawContent,
  })
  .strict()

export type OnboardingBootstrapSubmission = z.infer<typeof onboardingBootstrapSubmissionInput>

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function onboardingBootstrapInputHash(input: {
  venue: OnboardingBootstrapSubmission['venue']
  proposal: { version: 1; content: OnboardingBootstrapSubmission['rawContent'] }
}): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex')
}

function safeResult(run: {
  id: string
  venueId: string
  sourceKind: string
  status: string
  displayName: string
  createdAt: Date
  venue: { id: string; name: string; slug: string }
}) {
  return {
    runId: run.id,
    venue: run.venue,
    sourceKind: run.sourceKind,
    status: run.status,
    displayName: run.displayName,
    createdAt: run.createdAt,
    autoApprove: false as const,
    autoApply: false as const,
    published: false as const,
    nextAction: 'PATHFINDER_REVIEW' as const,
  }
}

const replaySelect = {
  id: true,
  venueId: true,
  sourceKind: true,
  status: true,
  displayName: true,
  submissionInputHash: true,
  createdAt: true,
  venue: { select: { id: true, name: true, slug: true } },
} as const

function requireActor(actor: OnboardingBootstrapActor): void {
  if (
    !actor ||
    actor.type !== 'HUMAN' ||
    typeof actor.id !== 'string' ||
    !actor.id.trim() ||
    !['OWNER', 'MANAGER'].includes(actor.role)
  ) {
    throw new OnboardingBootstrapError('INVALID_INPUT', 'A human venue manager is required')
  }
}

export async function submitOnboardingBootstrapAction(input: {
  tenantId: string
  actor: OnboardingBootstrapActor
  submission: OnboardingBootstrapSubmission
  client?: OnboardingBootstrapClient
}) {
  if (!input || typeof input !== 'object') {
    throw new OnboardingBootstrapError('INVALID_INPUT', 'Invalid onboarding action input')
  }
  requireActor(input.actor)
  if (typeof input.tenantId !== 'string' || !input.tenantId.trim()) {
    throw new OnboardingBootstrapError('INVALID_INPUT', 'Tenant is required')
  }
  const parsed = onboardingBootstrapSubmissionInput.safeParse(input.submission)
  if (!parsed.success)
    throw new OnboardingBootstrapError('INVALID_INPUT', 'Invalid onboarding submission')
  const client = input.client ?? db
  const submission = parsed.data
  const slug = normalizeVenueSlug(submission.venue.slug)
  const proposal = { version: 1 as const, content: submission.rawContent }
  const inputHash = onboardingBootstrapInputHash({
    venue: { ...submission.venue, slug },
    proposal,
  })

  try {
    return await client.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      await setContentVersionContext(tx, { actorId: input.actor.id })
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:onboarding:${input.tenantId}:${submission.requestId}`}, 0))`
      const replay = await tx.intakeRun.findFirst({
        where: { tenantId: input.tenantId, submissionRequestId: submission.requestId },
        select: replaySelect,
      })
      if (replay) {
        if (replay.submissionInputHash !== inputHash) {
          throw new OnboardingBootstrapError(
            'CONFLICT',
            'This submission key is already bound to different onboarding information.',
          )
        }
        return { ...safeResult(replay), replayed: true }
      }

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:venue-create:${input.tenantId}:${slug}`}, 0))`
      const slugOwner = await tx.venue.findFirst({
        where: { tenantId: input.tenantId, slug },
        select: { id: true },
      })
      if (slugOwner)
        throw new OnboardingBootstrapError('CONFLICT', 'This venue slug is already used.')

      const venue = await tx.venue.create({
        data: {
          tenantId: input.tenantId,
          name: submission.venue.name,
          slug,
          ...(submission.venue.category ? { category: submission.venue.category } : {}),
          guideMode: submission.venue.guideMode,
          isActive: false,
          ...(submission.venue.defaultCenterLat !== undefined
            ? { defaultCenterLat: submission.venue.defaultCenterLat }
            : {}),
          ...(submission.venue.defaultCenterLng !== undefined
            ? { defaultCenterLng: submission.venue.defaultCenterLng }
            : {}),
        },
        select: venueCreateSelect,
      })
      if ((venue.places?.length ?? 0) !== 0 || (venue.knowledgeEntries?.length ?? 0) !== 0) {
        throw new Error('Onboarding venue shell unexpectedly contained guest content')
      }
      const run = await tx.intakeRun.create({
        data: {
          tenantId: input.tenantId,
          venueId: venue.id,
          sourceKind: 'STRUCTURED_BOOTSTRAP',
          status: 'AWAITING_REVIEW',
          displayName: `${venue.name} onboarding information`,
          structuredBootstrap: proposal,
          submissionRequestId: submission.requestId,
          submissionInputHash: inputHash,
          requestedBy: input.actor.id,
        },
        select: replaySelect,
      })
      await tx.intakeEvidenceRecord.create({
        data: {
          tenantId: input.tenantId,
          venueId: venue.id,
          runId: run.id,
          sourceKind: 'STRUCTURED_BOOTSTRAP',
          locator: 'onboarding:structured-bootstrap:v1',
          normalizedHash: inputHash,
          confidence: 1,
          capturedAt: new Date(),
        },
      })
      await tx.intakeRunEvent.create({
        data: {
          tenantId: input.tenantId,
          venueId: venue.id,
          runId: run.id,
          kind: 'PROPOSAL_CREATED',
          actorId: input.actor.id,
          metadata: { sourceKind: 'STRUCTURED_BOOTSTRAP', autoApprove: false, autoApply: false },
        },
      })
      await tx.intakeRunEvent.create({
        data: {
          tenantId: input.tenantId,
          venueId: venue.id,
          runId: run.id,
          kind: 'EVIDENCE_RECORDED',
          actorId: input.actor.id,
          metadata: {
            evidenceKind: 'STRUCTURED_BOOTSTRAP_HASH',
            contentKind: submission.rawContent.kind,
          },
        },
      })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'onboarding.bootstrap-submitted',
          targetType: 'IntakeRun',
          targetId: run.id,
          afterState: {
            venueId: venue.id,
            sourceKind: 'STRUCTURED_BOOTSTRAP',
            status: 'AWAITING_REVIEW',
            requestId: submission.requestId,
            inputHash,
            contentKind: submission.rawContent.kind,
            autoApprove: false,
            autoApply: false,
          },
        },
        tx,
      )
      return { ...safeResult(run), replayed: false }
    })
  } catch (error) {
    if (error instanceof OnboardingBootstrapError) throw error
    if (isUniqueConflict(error)) {
      const replay = await client.intakeRun.findFirst({
        where: { tenantId: input.tenantId, submissionRequestId: submission.requestId },
        select: replaySelect,
      })
      if (replay?.submissionInputHash === inputHash) {
        return { ...safeResult(replay), replayed: true }
      }
      throw new OnboardingBootstrapError(
        'CONFLICT',
        replay
          ? 'This submission key is already bound to different onboarding information.'
          : 'This venue slug is already used.',
      )
    }
    throw error
  }
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

export async function getOnboardingBootstrapSubmission(input: {
  tenantId: string
  requestId: string
  client?: OnboardingBootstrapClient
}) {
  if (!input.tenantId || !z.string().uuid().safeParse(input.requestId).success) {
    throw new OnboardingBootstrapError('INVALID_INPUT', 'Invalid onboarding submission lookup')
  }
  const run = await (input.client ?? db).intakeRun.findFirst({
    where: { tenantId: input.tenantId, submissionRequestId: input.requestId },
    select: replaySelect,
  })
  if (!run) throw new OnboardingBootstrapError('NOT_FOUND', 'Onboarding submission not found')
  return safeResult(run)
}

export async function listOnboardingBootstrapDetails(input: {
  tenantId: string
  venueId: string
  limit: number
  client?: OnboardingBootstrapClient
}) {
  if (
    !input.tenantId ||
    !input.venueId ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    throw new OnboardingBootstrapError('INVALID_INPUT', 'Invalid onboarding review scope')
  }
  const venue = await (input.client ?? db).venue.findFirst({
    where: { tenantId: input.tenantId, id: input.venueId },
    select: { id: true },
  })
  if (!venue) throw new OnboardingBootstrapError('NOT_FOUND', 'Venue not found')
  return (input.client ?? db).intakeRun.findMany({
    where: { tenantId: input.tenantId, venueId: input.venueId, sourceKind: 'STRUCTURED_BOOTSTRAP' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit,
    select: {
      id: true,
      venueId: true,
      status: true,
      displayName: true,
      structuredBootstrap: true,
      createdAt: true,
    },
  })
}
