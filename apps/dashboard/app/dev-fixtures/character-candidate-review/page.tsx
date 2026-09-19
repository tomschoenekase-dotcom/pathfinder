'use client'

import {
  FounderCharacterCandidateReview,
  type FounderCharacterDecision,
  type FounderCharacterCandidate,
} from '../../../components/admin/FounderCharacterCandidateReview'
import { BotMakerWorkspace } from '../../../components/admin/BotMakerWorkspace'

const candidates: FounderCharacterCandidate[] = [
  {
    id: 'brief-neutral',
    tenantId: 'fixture-tenant',
    venueId: 'fixture-venue',
    clientName: 'Riverside Arts Trust',
    venueName: 'North Gallery',
    characterId: 'neutral-guide-a',
    displayName: 'Neutral guide A',
    version: 1,
    revision: 1,
    artifactFingerprint: 'a'.repeat(64),
    brief: 'A calm, readable guide for a public venue.',
    rationale: 'Clear silhouette and restrained expression for small screens.',
    provenance: 'Imported neutral source · verified fixture artifact',
    previewHref: `/api/admin/character-candidate-preview?tenantId=fixture-tenant&venueId=fixture-venue&briefId=brief-neutral&expectedVersion=1&expectedRevision=1&expectedArtifactFingerprint=${'a'.repeat(64)}`,
    current: true,
  },
  {
    id: 'brief-neutral-b',
    tenantId: 'fixture-tenant',
    venueId: 'fixture-venue',
    clientName: 'Riverside Arts Trust',
    venueName: 'North Gallery',
    characterId: 'neutral-guide-b',
    displayName: 'Neutral guide B',
    version: 1,
    revision: 2,
    artifactFingerprint: 'b'.repeat(64),
    brief: 'A second calm guide variant.',
    rationale: 'Softer proportions with the same bounded identity brief.',
    provenance: 'Imported neutral source · verified fixture artifact',
    previewHref: `/api/admin/character-candidate-preview?tenantId=fixture-tenant&venueId=fixture-venue&briefId=brief-neutral-b&expectedVersion=1&expectedRevision=2&expectedArtifactFingerprint=${'b'.repeat(64)}`,
    current: false,
  },
]

async function fixtureDecision(input: FounderCharacterDecision) {
  return { decision: input.decision, jobId: null }
}

export default function CharacterCandidateReviewFixturePage() {
  return (
    <main className="min-h-screen bg-slate-100 p-3 sm:p-8">
      <div className="mx-auto max-w-6xl">
        <BotMakerWorkspace
          reviewInbox={
            <FounderCharacterCandidateReview candidates={candidates} onDecision={fixtureDecision} />
          }
        />
      </div>
    </main>
  )
}
