import type { z } from 'zod'
import {
  MediaEntityCandidateSchema,
  mediaEvidenceLocatorId,
  type MediaEntityCandidate,
  type MediaEvidenceScope,
} from '@pathfinder/contracts/media-entity-resolution'
import { mediaIntakeHash } from './media-intake-snapshot'
import { mediaFindingSchema } from '../routers/admin/media-ingestion-review-schemas'

export function validateResolutionEvidence(params: {
  scope: MediaEvidenceScope
  sourceGeneration: string
  candidates: MediaEntityCandidate[]
  findings: unknown
  assets: Array<{ sourceId: string; sha256: string | null; status: string }>
}) {
  if (!Array.isArray(params.findings) || params.findings.length > 10_000)
    throw new Error('Media findings are unavailable or outside the review limit.')
  const requestedSources = new Set(
    params.candidates.flatMap((candidate) => candidate.evidence.map((item) => item.sourceId)),
  )
  const findingIndex = new Map<string, unknown>()
  for (const finding of params.findings) {
    if (
      !finding ||
      typeof finding !== 'object' ||
      !('sourceId' in finding) ||
      typeof finding.sourceId !== 'string'
    )
      continue
    if (!requestedSources.has(finding.sourceId)) continue
    if (findingIndex.has(finding.sourceId))
      throw new Error('Referenced source findings are ambiguous.')
    findingIndex.set(finding.sourceId, finding)
  }
  const assetIndex = new Map(params.assets.map((asset) => [asset.sourceId, asset]))
  if (assetIndex.size !== params.assets.length)
    throw new Error('Referenced source asset identities are ambiguous.')
  const retained = new Map<string, { locatorId: string; observation: unknown }>()
  const parsedFindings = new Map<string, z.infer<typeof mediaFindingSchema>>()
  const candidates = params.candidates.map((candidate) =>
    MediaEntityCandidateSchema.parse(candidate),
  )
  for (const candidate of candidates) {
    for (const locator of candidate.evidence) {
      if (
        locator.tenantId !== params.scope.tenantId ||
        locator.projectId !== params.scope.projectId ||
        locator.uploadAttemptId !== params.scope.uploadAttemptId
      ) {
        throw new Error('Candidate evidence belongs to another review scope.')
      }
      const asset = assetIndex.get(locator.sourceId)
      if (
        !asset ||
        asset.status !== 'COMPLETE' ||
        !asset.sha256 ||
        asset.sha256 !== locator.sourceSha256
      ) {
        throw new Error('Candidate source is unavailable, incomplete, or changed.')
      }
      let finding = parsedFindings.get(locator.sourceId)
      if (!finding) {
        finding = mediaFindingSchema.parse(findingIndex.get(locator.sourceId))
        parsedFindings.set(locator.sourceId, finding)
      }
      // New source observations supersede the legacy timed-video array only when present.
      const observations = Array.isArray(finding.sourceObservations)
        ? finding.sourceObservations
        : finding.observations
      const observation = observations?.[locator.observationIndex]
      if (!observation || mediaIntakeHash(observation) !== locator.observationSha256) {
        throw new Error('Candidate observation is unavailable or changed.')
      }
      const locatorId = mediaEvidenceLocatorId(locator)
      retained.set(locatorId, { locatorId, observation })
    }
  }
  const evidence = [...retained.values()].sort((a, b) =>
    a.locatorId < b.locatorId ? -1 : a.locatorId > b.locatorId ? 1 : 0,
  )
  const sources = [...parsedFindings]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([sourceId, finding]) => ({
      sourceId,
      sourceSha256: assetIndex.get(sourceId)!.sha256,
      filename: finding.filename,
      mediaType: finding.mediaType,
      summary: finding.summary,
      uncertainties: finding.uncertainties,
      ...(finding.videoAnalysisMethod ? { videoAnalysisMethod: finding.videoAnalysisMethod } : {}),
      ...(finding.videoAnalysisCoverage
        ? { videoAnalysisCoverage: finding.videoAnalysisCoverage }
        : {}),
    }))
  const evidenceSnapshot = {
    scope: params.scope,
    sourceGeneration: params.sourceGeneration,
    candidates,
    evidence,
    sources,
  }
  return { evidenceSnapshotHash: mediaIntakeHash(evidenceSnapshot), evidenceSnapshot }
}

/** Seed separate mentions; matching labels never silently merge extracted entities. */
export function deriveResolutionCandidates(params: {
  scope: MediaEvidenceScope
  findings: unknown
  assets: Array<{ sourceId: string; sha256: string | null; status: string }>
}) {
  if (!Array.isArray(params.findings) || params.findings.length > 10_000)
    throw new Error('Media findings exceed the review limit.')
  const assets = new Map(params.assets.map((asset) => [asset.sourceId, asset]))
  const candidates: MediaEntityCandidate[] = []
  const seen = new Set<string>()
  for (const raw of params.findings) {
    const finding = mediaFindingSchema.parse(raw)
    if (seen.has(finding.sourceId)) throw new Error('Referenced source findings are ambiguous.')
    seen.add(finding.sourceId)
    const asset = assets.get(finding.sourceId)
    if (!asset?.sha256 || asset.status !== 'COMPLETE') continue
    const observations = finding.sourceObservations ?? finding.observations ?? []
    for (const [observationIndex, observation] of observations.entries()) {
      if (observation.kind !== 'entity_candidate') continue
      if (candidates.length === 500) return { candidates, truncated: true }
      const locator = {
        ...params.scope,
        sourceId: finding.sourceId,
        sourceSha256: asset.sha256,
        observationIndex,
        observationSha256: mediaIntakeHash(observation),
      }
      candidates.push({
        candidateId: `mention-${mediaIntakeHash(locator).slice(0, 40)}`,
        label: observation.statement.slice(0, 200),
        kind: 'extracted-entity',
        evidence: [locator],
        identifiers: [],
        contextKeys: [],
      })
    }
  }
  return { candidates, truncated: false }
}
