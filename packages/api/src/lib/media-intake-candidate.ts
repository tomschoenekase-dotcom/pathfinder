import { createHash } from 'node:crypto'

import { VenuePackagePayloadV3 } from '../schemas/venue-package'
import {
  mediaIntakeEvidenceLocator,
  mediaIntakeHash,
  mediaIntakeHeldItemHashes,
  mediaIntakeSnapshotInput,
  validateMediaIntakeSnapshot,
} from './media-intake-snapshot'

type StoredMediaIntake = {
  id: string
  tenantId: string
  venueId: string
  requestedBy: string
  requestedByType: string
  submissionRequestId: string | null
  submissionInputHash: string | null
  structuredBootstrap: unknown
  evidence: Array<{
    locator: string
    normalizedHash: string
    sourceKind: string
    confidence: unknown
  }>
}

function itemKey(runId: string, kind: string, index: number, hash: string) {
  const bytes = createHash('sha256')
    .update(JSON.stringify([runId, kind, index, hash]))
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Rebuild from immutable receipts, never from the project's later mutable draft or findings. */
export function buildReviewedMediaIntakeCandidate(run: StoredMediaIntake) {
  const snapshot = validateMediaIntakeSnapshot(run.structuredBootstrap)
  if (
    snapshot.tenantId !== run.tenantId ||
    snapshot.venueId !== run.venueId ||
    snapshot.requestId !== run.submissionRequestId ||
    snapshot.reviewedBy !== run.requestedBy ||
    run.requestedByType !== 'HUMAN' ||
    run.submissionInputHash !==
      mediaIntakeHash({
        input: mediaIntakeSnapshotInput(snapshot),
        actorId: snapshot.reviewedBy,
      })
  ) {
    throw new Error('Media intake approval receipt does not match its exact scoped submission')
  }
  const expectedEvidence = new Map([
    ['media-project-review:snapshot:v1', mediaIntakeHash(snapshot)],
    ...snapshot.sources.map(
      (source) =>
        [mediaIntakeEvidenceLocator(snapshot, source.sourceId), source.analysisHash] as const,
    ),
  ])
  if (
    run.evidence.length !== expectedEvidence.size ||
    new Set(run.evidence.map((evidence) => evidence.locator)).size !== expectedEvidence.size ||
    run.evidence.some(
      (evidence) =>
        evidence.sourceKind !== 'STRUCTURED_BOOTSTRAP' ||
        Number(evidence.confidence) !== 1 ||
        expectedEvidence.get(evidence.locator) !== evidence.normalizedHash,
    )
  ) {
    throw new Error('Media intake evidence is missing, duplicated, or changed')
  }
  const identities = new Map(
    snapshot.bindings.map((binding) => [
      `${binding.kind}:${binding.itemIndex}`,
      {
        itemKey: itemKey(run.id, binding.kind, binding.itemIndex, binding.itemHash),
        provenance: {
          sourceType: 'REVIEWED_MEDIA_INTAKE',
          // This stable handle leads back to the full source set and uncertainty in the intake run.
          sourceName: `Media review ${run.id}`,
          contentOrigin: 'AI_GENERATED' as const,
        },
      },
    ]),
  )
  const held = mediaIntakeHeldItemHashes(snapshot)
  return VenuePackagePayloadV3.parse({
    schemaVersion: 3,
    places: {
      create: snapshot.draft.places.flatMap((value, index) =>
        held.has(mediaIntakeHash(value))
          ? []
          : [
              {
                ...identities.get(`place:${index}`),
                value,
              },
            ],
      ),
      update: [],
      delete: [],
    },
    knowledgeEntries: {
      create: snapshot.draft.knowledgeEntries.flatMap((value, index) =>
        held.has(mediaIntakeHash(value))
          ? []
          : [
              {
                ...identities.get(`knowledge:${index}`),
                value,
              },
            ],
      ),
      update: [],
      delete: [],
    },
  })
}
