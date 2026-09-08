import { createHash } from 'node:crypto'
import { z } from 'zod'

import {
  intakeSourceMappingDigest,
  reviewIntakeSourceForV1,
  type IntakeSourceMappingReviewSource,
} from '@pathfinder/db'

import type { TRPCContext } from '../context'
import {
  VenuePackagePayloadV3,
  type VenuePackagePayloadV3 as PayloadV3,
} from '../schemas/venue-package'
import {
  buildWebsiteVenuePackageMappingCandidate,
  WebsiteMappingSelections,
} from './intake-website-mapping'
import { venuePackagePayloadHash } from './venue-package-identity'

const base = {
  tenantId: z.string().trim().min(1).max(191),
  venueId: z.string().trim().min(1).max(191),
  operationId: z.string().uuid(),
  sourceRunId: z.string().trim().min(1).max(191),
  expectedSourceInputHash: z.string().regex(/^[a-f0-9]{64}$/u),
  reviewedBy: z.string().trim().min(1).max(191),
  rationale: z.string().trim().min(1).max(500),
}

export const WebsiteSourceMappingReviewInput = z
  .object({
    ...base,
    kind: z.literal('WEBSITE_MAPPING'),
    receiptId: z.string().uuid(),
    expectedResearchHash: z.string().regex(/^[a-f0-9]{64}$/u),
    selections: WebsiteMappingSelections,
  })
  .strict()

const noteRange = z
  .object({ start: z.number().int().min(0), end: z.number().int().min(1) })
  .strict()
export const OptionalNotesSourceMappingReviewInput = z
  .object({
    ...base,
    kind: z.literal('OPTIONAL_NOTES_SELECTION'),
    consentToPublicUse: z.literal(true),
    ranges: z.array(noteRange).min(1).max(20),
    title: z.string().trim().min(1).max(255),
    category: z.string().trim().min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    let priorEnd = -1
    value.ranges.forEach((range, index) => {
      if (range.end <= range.start || range.start < priorEnd) {
        context.addIssue({
          code: 'custom',
          path: ['ranges', index],
          message: 'Note ranges must be nonempty, ordered, and nonoverlapping.',
        })
      }
      priorEnd = range.end
    })
  })

export const IntakeSourceMappingReviewInput = z.union([
  WebsiteSourceMappingReviewInput,
  OptionalNotesSourceMappingReviewInput,
])

type ReviewDependency = typeof reviewIntakeSourceForV1
type WebsiteMappingDependency = typeof buildWebsiteVenuePackageMappingCandidate
export type IntakeSourceMappingReviewDependencies = {
  review: ReviewDependency
  buildWebsiteMapping: WebsiteMappingDependency
}
const defaultDependencies: IntakeSourceMappingReviewDependencies = {
  review: reviewIntakeSourceForV1,
  buildWebsiteMapping: buildWebsiteVenuePackageMappingCandidate,
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash('sha256').update(value).digest().subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function optionalNotes(source: IntakeSourceMappingReviewSource) {
  const stored = z
    .object({ kind: z.literal('OPTIONAL_NOTES'), notes: z.string().min(1).max(20_000) })
    .strict()
    .safeParse(source.structuredBootstrap)
  const evidence = source.evidence.find(({ locator }) => locator === `optional-notes:${source.id}`)
  if (!stored.success || !evidence)
    throw new Error('Stored optional notes evidence is unavailable.')
  const normalizedHash = createHash('sha256')
    .update(stored.data.notes.trim().replace(/\s+/gu, ' '))
    .digest('hex')
  if (evidence.normalizedHash !== normalizedHash)
    throw new Error('Stored optional notes evidence is inconsistent.')
  return { notes: stored.data.notes, normalizedHash }
}

export async function reviewIntakeSourceMappingForV1(
  input: {
    db: TRPCContext['db']
    command: z.input<typeof IntakeSourceMappingReviewInput>
  },
  dependencies: IntakeSourceMappingReviewDependencies = defaultDependencies,
) {
  const parsed = IntakeSourceMappingReviewInput.safeParse(input.command)
  if (!parsed.success) throw new Error('Invalid source mapping review command.')
  const command = parsed.data
  const requestIdentity = { schemaVersion: 1, ...command }
  return dependencies.review(
    {
      tenantId: command.tenantId,
      venueId: command.venueId,
      operationId: command.operationId,
      sourceRunId: command.sourceRunId,
      expectedSourceInputHash: command.expectedSourceInputHash,
      kind: command.kind,
      reviewedBy: command.reviewedBy,
      rationale: command.rationale,
      requestIdentity,
    },
    async (tx, source) => {
      if (command.kind === 'WEBSITE_MAPPING') {
        if (source.sourceKind !== 'WEBSITE') throw new Error('Website source is required.')
        const mapped = await dependencies.buildWebsiteMapping({
          db: tx as unknown as TRPCContext['db'],
          tenantId: command.tenantId,
          venueId: command.venueId,
          runId: command.sourceRunId,
          receiptId: command.receiptId,
          expectedResearchHash: command.expectedResearchHash,
          selections: command.selections,
          allowExistingHandoff: true,
        })
        const selectionSnapshot = {
          schemaVersion: 1,
          receiptId: mapped.receiptId,
          researchHash: mapped.researchHash,
          mappingReviewHash: mapped.mappingReviewHash,
          selections: mapped.selections,
          clarificationEvidence: mapped.clarificationEvidence,
        }
        return {
          researchReceiptId: mapped.receiptId,
          researchHash: mapped.researchHash,
          selectionSnapshot,
          selectionHash: intakeSourceMappingDigest(selectionSnapshot),
          payload: mapped.payload,
          payloadHash: venuePackagePayloadHash(command.venueId, mapped.payload),
        }
      }

      if (source.sourceKind !== 'STRUCTURED_BOOTSTRAP')
        throw new Error('Optional notes source is required.')
      if (source.requestedByType !== 'HUMAN')
        throw new Error('Only human-authored optional notes can be selected for public review.')
      const retained = optionalNotes(source)
      if (Buffer.byteLength(retained.notes, 'utf8') > 80_000)
        throw new Error('Stored optional notes exceed the review bound.')
      const characters = Array.from(retained.notes)
      if (command.ranges.some(({ end }) => end > characters.length))
        throw new Error('A note range is outside the retained source.')
      const excerpts = command.ranges.map(({ start, end }) => characters.slice(start, end).join(''))
      const content = excerpts.join('\n\n')
      if (!content.trim() || content.length > 10_000)
        throw new Error('Selected note text is empty or exceeds the public content bound.')
      const selectionSnapshot = {
        schemaVersion: 1,
        consentToPublicUse: true,
        sourceNotesHash: retained.normalizedHash,
        ranges: command.ranges,
        excerptHashes: excerpts.map((excerpt) =>
          createHash('sha256').update(excerpt).digest('hex'),
        ),
        title: command.title,
        category: command.category,
      }
      const payload: PayloadV3 = {
        schemaVersion: 3,
        places: { create: [], update: [], delete: [] },
        knowledgeEntries: {
          create: [
            {
              itemKey: deterministicUuid(
                `pathfinder:intake-notes-selection:v1:${command.tenantId}:${command.venueId}:${command.sourceRunId}:${intakeSourceMappingDigest(selectionSnapshot)}`,
              ),
              provenance: {
                sourceType: 'PATHFINDER_INTAKE',
                sourceName: 'Reviewed verbatim optional notes',
                contentOrigin: 'HUMAN_AUTHORED',
              },
              value: {
                title: command.title,
                category: command.category,
                content,
                isEnabled: true,
              },
            },
          ],
          update: [],
          delete: [],
        },
      }
      const validPayload = VenuePackagePayloadV3.parse(payload)
      return {
        researchReceiptId: null,
        researchHash: null,
        selectionSnapshot,
        selectionHash: intakeSourceMappingDigest(selectionSnapshot),
        payload: validPayload,
        payloadHash: venuePackagePayloadHash(command.venueId, validPayload),
      }
    },
    input.db,
  )
}
