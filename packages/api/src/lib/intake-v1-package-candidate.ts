import { createHash } from 'node:crypto'
import { z } from 'zod'
import { intakeV1ManifestHash } from '@pathfinder/db'

import type { TRPCContext } from '../context'
import {
  VenuePackagePayloadV3,
  type VenuePackagePayloadV3 as PayloadV3,
} from '../schemas/venue-package'
import {
  buildIntakeVenuePackageCandidate,
  IntakeVenuePackageCandidateError,
} from './intake-venue-package-candidate'
import { venuePackagePayloadHash } from './venue-package-identity'

const inputSchema = z
  .object({
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    submissionId: z.string().trim().min(1).max(191),
    revision: z.number().int().min(1),
    selectedMemberIds: z.array(z.string().trim().min(1).max(191)).min(1).max(50),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.selectedMemberIds).size !== value.selectedMemberIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['selectedMemberIds'],
        message: 'Selected V1 member IDs must be unique.',
      })
    }
  })

export class IntakeV1PackageCandidateError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'IntakeV1PackageCandidateError'
  }
}

type CandidateFragment = Awaited<ReturnType<typeof buildIntakeVenuePackageCandidate>>
export type IntakeV1PackageCandidateDependencies = {
  buildRunCandidate(input: {
    db: TRPCContext['db']
    tenantId: string
    venueId: string
    runId: string
    allowExistingHandoff: true
  }): Promise<CandidateFragment>
}

const defaultDependencies: IntakeV1PackageCandidateDependencies = {
  buildRunCandidate: buildIntakeVenuePackageCandidate,
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function emptyPayload(): PayloadV3 {
  return {
    schemaVersion: 3,
    places: { create: [], update: [], delete: [] },
    knowledgeEntries: { create: [], update: [], delete: [] },
  }
}

function appendFragment(target: PayloadV3, source: PayloadV3): boolean {
  if (source.venue !== undefined) {
    if (target.venue !== undefined && JSON.stringify(target.venue) !== JSON.stringify(source.venue))
      return false
    target.venue = source.venue
  }
  target.places.create.push(...source.places.create)
  target.places.update.push(...source.places.update)
  target.places.delete.push(...source.places.delete)
  target.knowledgeEntries.create.push(...source.knowledgeEntries.create)
  target.knowledgeEntries.update.push(...source.knowledgeEntries.update)
  target.knowledgeEntries.delete.push(...source.knowledgeEntries.delete)
  return true
}

export async function buildIntakeV1PackageCandidate(
  rawInput: z.input<typeof inputSchema> & { db: TRPCContext['db'] },
  dependencies: IntakeV1PackageCandidateDependencies = defaultDependencies,
) {
  const parsed = inputSchema.safeParse({
    tenantId: rawInput.tenantId,
    venueId: rawInput.venueId,
    submissionId: rawInput.submissionId,
    revision: rawInput.revision,
    selectedMemberIds: rawInput.selectedMemberIds,
  })
  if (!parsed.success)
    throw new IntakeV1PackageCandidateError('INVALID_INPUT', 'Invalid V1 package selection.')
  const input = parsed.data
  const revision = await rawInput.db.intakeV1SubmissionRevision.findFirst({
    where: {
      submissionId: input.submissionId,
      revision: input.revision,
      tenantId: input.tenantId,
      venueId: input.venueId,
    },
    select: {
      id: true,
      revision: true,
      manifest: true,
      manifestHash: true,
      members: {
        orderBy: { ordinal: 'asc' },
        take: 51,
        select: {
          id: true,
          ordinal: true,
          kind: true,
          immutableHash: true,
          intakeRunId: true,
          intakeUploadId: true,
          intakeRun: { select: { sourceKind: true, displayName: true, submissionInputHash: true } },
          intakeUpload: { select: { displayName: true, intakeRunId: true } },
          processingDispatch: { select: { kind: true, status: true, sourceHash: true } },
        },
      },
    },
  })
  if (!revision) throw new IntakeV1PackageCandidateError('NOT_FOUND', 'V1 revision not found.')
  if (revision.members.length > 50)
    throw new IntakeV1PackageCandidateError('CONFLICT', 'V1 revision exceeds 50 members.')
  const manifest = z
    .object({
      schemaVersion: z.literal(1),
      members: z
        .array(
          z
            .object({
              kind: z.enum(['INTAKE_RUN', 'INTAKE_UPLOAD']),
              id: z.string().min(1).max(191),
              immutableHash: z.string().regex(/^[a-f0-9]{64}$/u),
            })
            .strict(),
        )
        .max(50),
      criticalMissing: z.array(z.unknown()),
    })
    .strict()
    .safeParse(revision.manifest)
  const indexedMembers = revision.members.map((member) => ({
    kind: member.kind,
    id: member.kind === 'INTAKE_RUN' ? member.intakeRunId : member.intakeUploadId,
    immutableHash: member.immutableHash,
  }))
  if (
    !manifest.success ||
    intakeV1ManifestHash(manifest.data) !== revision.manifestHash ||
    JSON.stringify(manifest.data.members) !== JSON.stringify(indexedMembers)
  )
    throw new IntakeV1PackageCandidateError(
      'CONFLICT',
      'Stored V1 revision manifest is inconsistent.',
    )

  const selected = new Set(input.selectedMemberIds)
  if (selected.size !== input.selectedMemberIds.length)
    throw new IntakeV1PackageCandidateError('INVALID_INPUT', 'Selected member IDs must be unique.')
  if (input.selectedMemberIds.some((id) => !revision.members.some((member) => member.id === id)))
    throw new IntakeV1PackageCandidateError(
      'CONFLICT',
      'A selected member is not part of the exact V1 revision.',
    )

  const payload = emptyPayload()
  const memberResults: Array<{
    memberId: string
    ordinal: number
    selected: boolean
    displayName: string | null
    sourceKind: string | null
    state: 'READY' | 'REMAINING' | 'REVIEW_REQUIRED' | 'WAITING' | 'HELD' | 'INVALID'
    candidateHash: string | null
    issues: Array<{ code: string; message: string }>
  }> = []

  for (const member of revision.members) {
    const isSelected = selected.has(member.id)
    const sourceKind = member.intakeRun?.sourceKind ?? null
    const base = {
      memberId: member.id,
      ordinal: member.ordinal,
      selected: isSelected,
      displayName: member.intakeRun?.displayName ?? member.intakeUpload?.displayName ?? null,
      sourceKind,
    }
    if (!isSelected) {
      memberResults.push({ ...base, state: 'REMAINING', candidateHash: null, issues: [] })
      continue
    }
    const dispatch = member.processingDispatch
    if (
      !dispatch ||
      dispatch.sourceHash !== member.immutableHash ||
      (member.intakeRun && member.intakeRun.submissionInputHash !== member.immutableHash)
    ) {
      memberResults.push({
        ...base,
        state: 'INVALID',
        candidateHash: null,
        issues: [
          { code: 'SOURCE_IDENTITY_MISMATCH', message: 'Stored source identity is inconsistent.' },
        ],
      })
      continue
    }
    if (dispatch.status === 'PENDING' || dispatch.status === 'LEASED') {
      memberResults.push({
        ...base,
        state: 'WAITING',
        candidateHash: null,
        issues: [
          {
            code: 'SOURCE_PROCESSING_PENDING',
            message: 'Selected source processing is not complete.',
          },
        ],
      })
      continue
    }
    if (dispatch.status === 'HELD' || dispatch.status === 'FAILED') {
      memberResults.push({
        ...base,
        state: 'HELD',
        candidateHash: null,
        issues: [
          {
            code: 'SOURCE_PROCESSING_HELD',
            message: 'Selected source processing needs operator review.',
          },
        ],
      })
      continue
    }
    if (sourceKind === 'WEBSITE') {
      memberResults.push({
        ...base,
        state: 'REVIEW_REQUIRED',
        candidateHash: null,
        issues: [
          {
            code: 'WEBSITE_MAPPING_REQUIRED',
            message: 'Website evidence requires explicit reviewed mapping selections.',
          },
        ],
      })
      continue
    }
    if (
      member.kind !== 'INTAKE_RUN' ||
      !member.intakeRunId ||
      (sourceKind !== 'STRUCTURED_BOOTSTRAP' && sourceKind !== 'INTERVIEW')
    ) {
      memberResults.push({
        ...base,
        state: 'REVIEW_REQUIRED',
        candidateHash: null,
        issues: [
          {
            code: 'SOURCE_ADAPTER_REQUIRED',
            message: 'This source has no reviewed package mapping adapter.',
          },
        ],
      })
      continue
    }
    let fragment: CandidateFragment
    try {
      fragment = await dependencies.buildRunCandidate({
        db: rawInput.db,
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: member.intakeRunId,
        allowExistingHandoff: true,
      })
    } catch (error) {
      if (!(error instanceof IntakeVenuePackageCandidateError)) throw error
      memberResults.push({
        ...base,
        state: error.code === 'INVALID_EVIDENCE' ? 'INVALID' : 'REVIEW_REQUIRED',
        candidateHash: null,
        issues: [{ code: error.code, message: error.message }],
      })
      continue
    }
    if (!fragment.ready || !fragment.payload || !fragment.candidateHash) {
      memberResults.push({
        ...base,
        state: 'REVIEW_REQUIRED',
        candidateHash: fragment.candidateHash,
        issues: fragment.issues.map((issue) => ({ code: issue.code, message: issue.message })),
      })
      continue
    }
    if (!appendFragment(payload, fragment.payload)) {
      memberResults.push({
        ...base,
        state: 'INVALID',
        candidateHash: fragment.candidateHash,
        issues: [
          {
            code: 'CONFLICTING_VENUE_PATCH',
            message: 'Selected sources propose conflicting venue changes.',
          },
        ],
      })
      continue
    }
    memberResults.push({
      ...base,
      state: 'READY',
      candidateHash: fragment.candidateHash,
      issues: [],
    })
  }

  const selectedResults = memberResults.filter((member) => member.selected)
  let parsedPayload = selectedResults.every((member) => member.state === 'READY')
    ? VenuePackagePayloadV3.safeParse(payload)
    : null
  if (parsedPayload && !parsedPayload.success) {
    memberResults.push({
      memberId: 'aggregate',
      ordinal: revision.members.length,
      selected: true,
      displayName: null,
      sourceKind: null,
      state: 'INVALID',
      candidateHash: null,
      issues: parsedPayload.error.issues.map((issue) => ({
        code: 'AGGREGATE_PAYLOAD_INVALID',
        message: issue.message,
      })),
    })
    parsedPayload = null
  }
  const resultPayload = parsedPayload?.success ? parsedPayload.data : null
  const orderedSelection = revision.members
    .filter((member) => selected.has(member.id))
    .map((member) => ({ id: member.id, immutableHash: member.immutableHash }))
  const payloadHash = resultPayload ? venuePackagePayloadHash(input.venueId, resultPayload) : null
  const selectionHash = hash(JSON.stringify(orderedSelection))
  const candidateHash = payloadHash
    ? hash(
        JSON.stringify([
          'pathfinder:intake-v1-package-candidate:v1',
          input.tenantId,
          input.venueId,
          input.submissionId,
          revision.id,
          revision.revision,
          revision.manifestHash,
          selectionHash,
          orderedSelection,
          selectedResults.map(({ memberId, candidateHash: fragmentHash }) => [
            memberId,
            fragmentHash,
          ]),
          payloadHash,
        ]),
      )
    : null
  return {
    submissionId: input.submissionId,
    revisionId: revision.id,
    revision: revision.revision,
    manifestHash: revision.manifestHash,
    submissionOmissionCount: manifest.data.criticalMissing.length,
    selectedMemberIds: orderedSelection.map(({ id }) => id),
    remainingMemberIds: revision.members
      .filter((member) => !selected.has(member.id))
      .map(({ id }) => id),
    selectionHash,
    ready: resultPayload !== null,
    payload: resultPayload,
    payloadHash,
    candidateHash,
    members: memberResults,
    autoApprove: false as const,
    autoApply: false as const,
    published: false as const,
  }
}
