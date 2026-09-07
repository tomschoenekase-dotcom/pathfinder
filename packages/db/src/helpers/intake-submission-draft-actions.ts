import { z } from 'zod'
import type { Prisma } from '@prisma/client'

import { db } from '../client'

export const intakeSubmissionDraftSourceKind = z.enum(['WEBSITE', 'INTERVIEW', 'NOTES'])
const sourceKind = intakeSubmissionDraftSourceKind
const interviewRole = z.enum([
  'EXECUTIVE',
  'VISITOR_SERVICES',
  'OPERATIONS',
  'CONTENT',
  'ACCESSIBILITY',
])
const answerDraft = z
  .object({
    mode: z.enum(['ANSWER', 'SKIP', 'REDACT']),
    text: z.string().max(20_000),
    privacy: z.enum(['PUBLIC_CANDIDATE', 'INTERNAL_CONTEXT', 'PRIVATE']),
    uncertain: z.boolean(),
    confidence: z.number().min(0).max(1),
  })
  .strict()
export const intakeSubmissionDraftContent = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('WEBSITE'),
        displayName: z.string().max(255),
        websiteUri: z.string().max(2000),
      })
      .strict(),
    z.object({ kind: z.literal('NOTES'), notes: z.string().max(20_000) }).strict(),
    z
      .object({
        kind: z.literal('INTERVIEW'),
        displayName: z.string().max(255),
        role: interviewRole,
        consent: z.boolean(),
        draftsByRole: z
          .record(
            interviewRole,
            z
              .record(z.string().min(1).max(191), answerDraft)
              .refine((answers) => Object.keys(answers).length <= 50),
          )
          .refine((roles) => Object.keys(roles).length <= 6),
      })
      .strict(),
  ])
  .refine((content) => Buffer.byteLength(JSON.stringify(content), 'utf8') <= 250_000, {
    message: 'Draft content exceeds the 250 KB limit.',
  })
const scope = z.object({
  tenantId: z.string().min(1).max(191),
  venueId: z.string().min(1).max(191),
  ownerUserId: z.string().min(1).max(191),
  sourceKind,
})

export class IntakeSubmissionDraftError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message)
  }
}

type Client = Pick<typeof db, 'intakeSubmissionDraft' | '$transaction'>

export async function getIntakeSubmissionDraft(input: z.infer<typeof scope>, client: Client = db) {
  const parsed = scope.safeParse(input)
  if (!parsed.success) throw new IntakeSubmissionDraftError('INVALID_INPUT', 'Invalid draft scope.')
  return client.intakeSubmissionDraft.findUnique({
    where: { tenantId_venueId_ownerUserId_sourceKind: parsed.data },
    select: {
      id: true,
      content: true,
      revision: true,
      submittedProposalId: true,
      submittedAt: true,
      updatedAt: true,
    },
  })
}

export async function saveIntakeSubmissionDraft(
  input: z.infer<typeof scope> & { content: Prisma.InputJsonValue; expectedRevision?: number },
  client: Client = db,
) {
  const parsed = scope
    .extend({
      content: intakeSubmissionDraftContent,
      expectedRevision: z.number().int().min(0).optional(),
    })
    .safeParse(input)
  if (!parsed.success) throw new IntakeSubmissionDraftError('INVALID_INPUT', 'Invalid draft save.')
  const value = parsed.data
  if (value.content.kind !== value.sourceKind)
    throw new IntakeSubmissionDraftError(
      'INVALID_INPUT',
      'Draft content does not match its source kind.',
    )
  try {
    return await client.$transaction(async (tx) => {
      const existing = await tx.intakeSubmissionDraft.findUnique({
        where: {
          tenantId_venueId_ownerUserId_sourceKind: {
            tenantId: value.tenantId,
            venueId: value.venueId,
            ownerUserId: value.ownerUserId,
            sourceKind: value.sourceKind,
          },
        },
        select: { id: true, revision: true, submittedAt: true },
      })
      if (!existing) {
        if (value.expectedRevision !== undefined && value.expectedRevision !== 0)
          throw new IntakeSubmissionDraftError(
            'CONFLICT',
            'Draft state changed; reload before saving.',
          )
        return tx.intakeSubmissionDraft.create({
          data: {
            tenantId: value.tenantId,
            venueId: value.venueId,
            ownerUserId: value.ownerUserId,
            sourceKind: value.sourceKind,
            content: value.content as Prisma.InputJsonValue,
          },
          select: { id: true, revision: true, updatedAt: true },
        })
      }
      if (existing.submittedAt) {
        if (value.expectedRevision !== 0)
          throw new IntakeSubmissionDraftError(
            'CONFLICT',
            'Draft state changed; reload before saving.',
          )
        const reopened = await tx.intakeSubmissionDraft.updateMany({
          where: {
            id: existing.id,
            tenantId: value.tenantId,
            revision: existing.revision,
            submittedAt: { not: null },
          },
          data: {
            content: value.content as Prisma.InputJsonValue,
            submittedAt: null,
            submittedProposalId: null,
            revision: { increment: 1 },
          },
        })
        if (reopened.count !== 1)
          throw new IntakeSubmissionDraftError(
            'CONFLICT',
            'Draft state changed; reload before saving.',
          )
        return tx.intakeSubmissionDraft.findUniqueOrThrow({
          where: { id: existing.id },
          select: { id: true, revision: true, updatedAt: true },
        })
      }
      if (value.expectedRevision === undefined || value.expectedRevision !== existing.revision)
        throw new IntakeSubmissionDraftError(
          'CONFLICT',
          'Draft state changed; reload before saving.',
        )
      const updated = await tx.intakeSubmissionDraft.updateMany({
        where: {
          id: existing.id,
          tenantId: value.tenantId,
          revision: value.expectedRevision,
          submittedAt: null,
        },
        data: { content: value.content as Prisma.InputJsonValue, revision: { increment: 1 } },
      })
      if (updated.count !== 1)
        throw new IntakeSubmissionDraftError(
          'CONFLICT',
          'Draft state changed; reload before saving.',
        )
      return tx.intakeSubmissionDraft.findUniqueOrThrow({
        where: { id: existing.id },
        select: { id: true, revision: true, updatedAt: true },
      })
    })
  } catch (error) {
    if (error instanceof IntakeSubmissionDraftError) throw error
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      throw new IntakeSubmissionDraftError('CONFLICT', 'Draft state changed; reload before saving.')
    }
    throw error
  }
}

export async function markIntakeSubmissionDraftSubmitted(
  input: z.infer<typeof scope> & { expectedRevision: number; proposalId: string },
  client: Client = db,
) {
  const parsed = scope
    .extend({ expectedRevision: z.number().int().min(1), proposalId: z.string().min(1).max(191) })
    .safeParse(input)
  if (!parsed.success)
    throw new IntakeSubmissionDraftError('INVALID_INPUT', 'Invalid draft submission.')
  const value = parsed.data
  const updated = await client.intakeSubmissionDraft.updateMany({
    where: {
      tenantId: value.tenantId,
      venueId: value.venueId,
      ownerUserId: value.ownerUserId,
      sourceKind: value.sourceKind,
      revision: value.expectedRevision,
      submittedAt: null,
    },
    data: {
      submittedProposalId: value.proposalId,
      submittedAt: new Date(),
      revision: { increment: 1 },
    },
  })
  if (updated.count !== 1)
    throw new IntakeSubmissionDraftError(
      'CONFLICT',
      'Draft state changed; reload before submitting.',
    )
}
