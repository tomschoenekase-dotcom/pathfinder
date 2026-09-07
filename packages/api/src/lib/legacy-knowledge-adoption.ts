import { createHash } from 'node:crypto'

import {
  GeneralizedContentRevisionDraft,
  type GeneralizedContentRevisionDraft as GeneralizedContentRevisionDraftValue,
} from '@pathfinder/contracts/universal-content-actions'
import {
  LegacyKnowledgeSnapshot,
  type LegacyKnowledgeSnapshot as LegacyKnowledgeSnapshotValue,
} from '@pathfinder/contracts/legacy-knowledge-adoption'

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function legacyKnowledgeSnapshotHash(snapshot: LegacyKnowledgeSnapshotValue) {
  return hash({ schemaVersion: 1, snapshot: LegacyKnowledgeSnapshot.parse(snapshot) })
}

export function legacyKnowledgeAdoptionDraftHash(input: {
  proposalId: string
  previewHash: string
  legacySnapshotHash: string
  draft: GeneralizedContentRevisionDraftValue
}) {
  return hash({
    schemaVersion: 1,
    proposalId: input.proposalId,
    previewHash: input.previewHash,
    legacySnapshotHash: input.legacySnapshotHash,
    draft: GeneralizedContentRevisionDraft.parse(input.draft),
  })
}

export function legacyKnowledgeAdoptionModuleId(input: {
  tenantId: string
  venueId: string
  legacyKnowledgeEntryId: string
  legacySnapshotHash: string
}) {
  const bytes = Buffer.from(
    createHash('sha256')
      .update(
        JSON.stringify([
          'pathfinder:legacy-knowledge-adoption:v1',
          input.tenantId,
          input.venueId,
          input.legacyKnowledgeEntryId,
          input.legacySnapshotHash,
        ]),
      )
      .digest()
      .subarray(0, 16),
  )
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const value = bytes.toString('hex')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}
