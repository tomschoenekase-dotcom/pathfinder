import { createHash } from 'node:crypto'
import { z } from 'zod'

import { VenuePackagePayloadV3 } from '../schemas/venue-package'

export const SEMANTIC_UPDATE_CLASSIFICATIONS = [
  'ADDITION',
  'CORRECTION',
  'SUPERSESSION',
  'TEMPORAL',
  'CONFLICT',
  'DUPLICATE_NOOP',
] as const

export type SemanticUpdateClassification = (typeof SEMANTIC_UPDATE_CLASSIFICATIONS)[number]

export const SOURCE_AUTHORITY = {
  UNVERIFIED: 0,
  PUBLIC_SECONDARY: 1,
  TRUSTED_PARTNER: 2,
  OFFICIAL_VENUE_SOURCE: 3,
  VENUE_CONFIRMED: 4,
} as const

export type SemanticSourceAuthority = keyof typeof SOURCE_AUTHORITY

const sourceEvidence = z
  .object({
    id: z.string().trim().min(1).max(191),
    sourceType: z.string().trim().min(1).max(64),
    authority: z.enum(
      Object.keys(SOURCE_AUTHORITY) as [SemanticSourceAuthority, ...SemanticSourceAuthority[]],
    ),
    confidence: z.number().min(0).max(1),
    normalizedHash: z.string().regex(/^[a-f0-9]{64}$/u),
    retrievedAt: z.string().datetime(),
    sourceName: z.string().trim().min(1).max(200).optional(),
    sourceUrl: z.string().url().max(2000).optional(),
  })
  .strict()

export const SemanticUpdaterDesiredKnowledge = z
  .object({
    title: z.string().trim().min(1).max(200),
    category: z.string().trim().min(1).max(100),
    content: z.string().trim().min(1).max(5000),
    isEnabled: z.boolean(),
  })
  .strict()

const semanticUpdaterInput = z
  .object({
    venueId: z.string().trim().min(1).max(191),
    relation: z.enum(['NEW_FACT', 'CORRECTS', 'SUPERSEDES']),
    targetKnowledgeEntryId: z.string().trim().min(1).max(191).optional(),
    desired: SemanticUpdaterDesiredKnowledge,
    contentOrigin: z.enum(['HUMAN_AUTHORED', 'AI_GENERATED']),
    evidenceReview: z.enum(['UNREVIEWED', 'HUMAN_REVIEWED']),
    evidence: z.array(sourceEvidence).min(1).max(20),
    validFrom: z.string().datetime().optional(),
    validUntil: z.string().datetime().optional(),
    operationalUpdateType: z
      .enum([
        'GENERAL_NOTICE',
        'TEMPORARY_CLOSURE',
        'UNAVAILABLE_EXHIBIT',
        'CHANGED_HOURS',
        'MAINTENANCE',
        'SPECIAL_EVENT',
        'SOLD_OUT_ACTIVITY',
        'TEMPORARY_VENDOR_LOCATION',
      ])
      .default('GENERAL_NOTICE'),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.validFrom === undefined) !== (value.validUntil === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validUntil'],
        message: 'Temporal updates require both validFrom and validUntil.',
      })
    }
    if (
      value.validFrom &&
      value.validUntil &&
      Date.parse(value.validFrom) >= Date.parse(value.validUntil)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validUntil'],
        message: 'Temporal update expiry must be after its start.',
      })
    }
  })

export type SemanticUpdaterInput = z.input<typeof semanticUpdaterInput>

export type CurrentVenueKnowledge = {
  id: string
  title: string
  category: string
  content: string
  isEnabled: boolean
  authority: SemanticSourceAuthority
}

export type SemanticUpdaterBlocker = { code: string; path: string; message: string }

function canonicalText(value: string) {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
}

function sameLogicalKey(
  left: Pick<CurrentVenueKnowledge, 'title' | 'category'>,
  right: Pick<CurrentVenueKnowledge, 'title' | 'category'>,
) {
  return (
    canonicalText(left.title) === canonicalText(right.title) &&
    canonicalText(left.category) === canonicalText(right.category)
  )
}

function sameKnowledge(
  left: Pick<CurrentVenueKnowledge, 'title' | 'category' | 'content' | 'isEnabled'>,
  right: Pick<CurrentVenueKnowledge, 'title' | 'category' | 'content' | 'isEnabled'>,
) {
  return (
    sameLogicalKey(left, right) &&
    canonicalText(left.content) === canonicalText(right.content) &&
    left.isEnabled === right.isEnabled
  )
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash('sha256').update(value).digest().subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function buildSemanticVenueUpdate(
  rawInput: SemanticUpdaterInput,
  currentEntries: readonly CurrentVenueKnowledge[],
) {
  const input = semanticUpdaterInput.parse(rawInput)
  const rankedEvidence = [...input.evidence].sort(
    (left, right) =>
      SOURCE_AUTHORITY[right.authority] - SOURCE_AUTHORITY[left.authority] ||
      right.confidence - left.confidence ||
      left.id.localeCompare(right.id),
  )
  const primary = rankedEvidence[0]!
  const evidenceRefs = rankedEvidence.map(
    (item) => `source-evidence:${item.id}:${item.normalizedHash}`,
  )
  const exactMatch = currentEntries.find((entry) => sameKnowledge(entry, input.desired))
  const target = input.targetKnowledgeEntryId
    ? currentEntries.find((entry) => entry.id === input.targetKnowledgeEntryId)
    : undefined
  const logicalMatches = currentEntries.filter((entry) => sameLogicalKey(entry, input.desired))
  const blockers: SemanticUpdaterBlocker[] = []

  let classification: SemanticUpdateClassification
  if (input.validFrom && input.validUntil) {
    if (input.evidenceReview === 'UNREVIEWED') {
      classification = 'CONFLICT'
      blockers.push({
        code: 'EVIDENCE_REVIEW_REQUIRED',
        path: 'evidence',
        message: 'Human evidence review is required before proposing a semantic content change.',
      })
    } else {
      classification = 'TEMPORAL'
    }
  } else if (exactMatch) {
    classification = 'DUPLICATE_NOOP'
  } else if (input.evidenceReview === 'UNREVIEWED') {
    classification = 'CONFLICT'
    blockers.push({
      code: 'EVIDENCE_REVIEW_REQUIRED',
      path: 'evidence',
      message: 'Human evidence review is required before proposing a semantic content change.',
    })
  } else if (input.relation === 'NEW_FACT' && input.targetKnowledgeEntryId) {
    classification = 'CONFLICT'
    blockers.push({
      code: 'NEW_FACT_TARGET_CONFLICT',
      path: 'targetKnowledgeEntryId',
      message: 'A new fact cannot target an existing knowledge entry.',
    })
  } else if (
    input.relation === 'NEW_FACT' &&
    !input.targetKnowledgeEntryId &&
    logicalMatches.length === 0
  ) {
    classification = 'ADDITION'
  } else if (!target) {
    classification = 'CONFLICT'
    blockers.push({
      code: input.targetKnowledgeEntryId ? 'TARGET_NOT_FOUND' : 'TARGET_REQUIRED',
      path: 'targetKnowledgeEntryId',
      message: input.targetKnowledgeEntryId
        ? 'The requested target is not current in this venue scope.'
        : 'A conflicting logical fact requires an explicit target before it can be changed.',
    })
  } else if (SOURCE_AUTHORITY[primary.authority] < SOURCE_AUTHORITY[target.authority]) {
    classification = 'CONFLICT'
    blockers.push({
      code: 'LOWER_AUTHORITY_CONFLICT',
      path: 'evidence',
      message:
        'Lower-authority evidence cannot replace the current venue fact without clarification.',
    })
  } else {
    classification = input.relation === 'SUPERSEDES' ? 'SUPERSESSION' : 'CORRECTION'
  }

  const provenance = {
    sourceType: primary.sourceType,
    ...(primary.sourceName ? { sourceName: primary.sourceName } : {}),
    ...(primary.sourceUrl ? { sourceUrl: primary.sourceUrl } : {}),
    contentOrigin: input.contentOrigin,
  }
  const itemKey = deterministicUuid(
    JSON.stringify({
      venueId: input.venueId,
      classification,
      targetKnowledgeEntryId: input.targetKnowledgeEntryId ?? null,
      desired: input.desired,
      evidence: evidenceRefs,
    }),
  )

  const venuePackagePatch =
    classification === 'ADDITION'
      ? VenuePackagePayloadV3.parse({
          schemaVersion: 3,
          places: { create: [], update: [], delete: [] },
          knowledgeEntries: {
            create: [{ itemKey, provenance, value: input.desired }],
            update: [],
            delete: [],
          },
        })
      : (classification === 'CORRECTION' || classification === 'SUPERSESSION') && target
        ? VenuePackagePayloadV3.parse({
            schemaVersion: 3,
            places: { create: [], update: [], delete: [] },
            knowledgeEntries: {
              create: [],
              update: [{ itemKey, id: target.id, provenance, value: input.desired }],
              delete: [],
            },
          })
        : null

  const operationalUpdateDraft =
    classification === 'TEMPORAL'
      ? {
          updateType: input.operationalUpdateType,
          severity: 'INFO' as const,
          priority: 'NORMAL' as const,
          title: input.desired.title,
          body: input.desired.content,
          startsAt: input.validFrom!,
          expiresAt: input.validUntil!,
          status: 'DRAFT' as const,
          autoSchedule: false as const,
          autoPublish: false as const,
        }
      : null

  const previewHash = createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        classification,
        confidence: Math.min(...rankedEvidence.map((item) => item.confidence)),
        authority: primary.authority,
        targetKnowledgeEntryId: target?.id ?? null,
        evidenceRefs,
        blockers,
        venuePackagePatch,
        operationalUpdateDraft,
      }),
    )
    .digest('hex')

  return {
    schemaVersion: 1 as const,
    previewHash,
    classification,
    confidence: Math.min(...rankedEvidence.map((item) => item.confidence)),
    authority: primary.authority,
    targetKnowledgeEntryId: target?.id ?? null,
    evidenceRefs,
    blockers,
    questions:
      classification === 'CONFLICT'
        ? [
            {
              owner: 'VENUE_OPERATOR' as const,
              prompt: `Which ${input.desired.category.toLowerCase()} information should visitors receive for “${input.desired.title}”?`,
              blockerCodes: blockers.map(({ code }) => code),
            },
          ]
        : [],
    venuePackagePatch,
    operationalUpdateDraft,
    operationCount: venuePackagePatch ? 1 : operationalUpdateDraft ? 1 : 0,
    requiresHumanReview: classification !== 'DUPLICATE_NOOP',
    autoApprove: false as const,
    autoApply: false as const,
    autoPublish: false as const,
  }
}
