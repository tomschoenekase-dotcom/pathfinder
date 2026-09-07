import { z } from 'zod'

import {
  MediaEntityCandidateSchema,
  MediaEvidenceScopeSchema,
  createMediaEvidenceLocatorIndex,
  type MediaEntityCandidate,
  type MediaEvidenceScope,
} from './media-entity-resolution'

const id = z.string().min(1).max(191)
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const decisionBase = {
  requestId: uuid,
  reviewerId: id,
  rationale: z.string().trim().min(1).max(2000),
}

/** These identities exist only in media review; they grant no native/public content authority. */
export const MediaResolutionDecisionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...decisionBase,
      kind: z.literal('MERGE'),
      candidateIds: z.array(id).min(2).max(100),
      representativeId: id,
    })
    .strict(),
  z
    .object({
      ...decisionBase,
      kind: z.literal('REVERT_MERGE'),
      mergeRequestId: uuid,
    })
    .strict(),
])
export type MediaResolutionDecision = z.infer<typeof MediaResolutionDecisionSchema>

export const MediaResolutionStateSchema = z
  .object({
    version: z.literal(1),
    scope: MediaEvidenceScopeSchema,
    candidates: z.array(MediaEntityCandidateSchema).min(1).max(500),
    decisions: z.array(MediaResolutionDecisionSchema).max(500),
  })
  .strict()
export type MediaResolutionState = z.infer<typeof MediaResolutionStateSchema>

type Projection = {
  representativeByCandidate: Map<string, string>
  activeMergeIds: Set<string>
}

function projectValidatedState(state: MediaResolutionState): Projection {
  const candidateIds = new Set(state.candidates.map((candidate) => candidate.candidateId))
  if (candidateIds.size !== state.candidates.length)
    throw new Error('Candidate IDs must be unique.')
  for (const candidate of state.candidates) {
    createMediaEvidenceLocatorIndex(state.scope, candidate.evidence)
  }
  const requests = new Set<string>()
  const active = new Map<string, Extract<MediaResolutionDecision, { kind: 'MERGE' }>>()
  const representativeByCandidate = new Map([...candidateIds].map((value) => [value, value]))
  const rebuild = () => {
    for (const value of candidateIds) representativeByCandidate.set(value, value)
    for (const merge of active.values()) {
      for (const value of merge.candidateIds)
        representativeByCandidate.set(value, merge.representativeId)
    }
  }
  for (const decision of state.decisions) {
    if (requests.has(decision.requestId))
      throw new Error('Review decision request IDs must be unique.')
    requests.add(decision.requestId)
    if (decision.kind === 'MERGE') {
      const members = new Set(decision.candidateIds)
      if (
        members.size !== decision.candidateIds.length ||
        !members.has(decision.representativeId)
      ) {
        throw new Error('A merge needs unique candidates and a representative among them.')
      }
      if ([...members].some((member) => !candidateIds.has(member))) {
        throw new Error('A merge candidate is outside the frozen review.')
      }
      const touchedGroups = new Set(
        [...members].map((member) => representativeByCandidate.get(member)!),
      )
      if (touchedGroups.size < 2) throw new Error('The candidates are already one reviewed entity.')
      for (const [member, representative] of representativeByCandidate) {
        if (touchedGroups.has(representative) && !members.has(member)) {
          throw new Error('Merge decisions must retain every member of existing groups.')
        }
      }
      active.set(decision.requestId, decision)
      rebuild()
    } else {
      const original = active.get(decision.mergeRequestId)
      if (!original) throw new Error('The referenced merge is not active.')
      const members = new Set(original.candidateIds)
      let afterOriginal = false
      for (const merge of active.values()) {
        if (merge.requestId === original.requestId) {
          afterOriginal = true
          continue
        }
        if (afterOriginal && merge.candidateIds.some((member) => members.has(member))) {
          throw new Error('Revert dependent merges first so source references remain consistent.')
        }
      }
      active.delete(original.requestId)
      rebuild()
    }
  }
  return { representativeByCandidate, activeMergeIds: new Set(active.keys()) }
}

export function createMediaResolutionState(
  scope: MediaEvidenceScope,
  candidates: MediaEntityCandidate[],
) {
  const state = MediaResolutionStateSchema.parse({ version: 1, scope, candidates, decisions: [] })
  projectValidatedState(state)
  return state
}

export function appendMediaResolutionDecision(
  input: unknown,
  decisionInput: unknown,
): MediaResolutionState {
  const current = MediaResolutionStateSchema.parse(input)
  projectValidatedState(current)
  const decision = MediaResolutionDecisionSchema.parse(decisionInput)
  const existing = current.decisions.find((entry) => entry.requestId === decision.requestId)
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(decision))
      throw new Error('Review request already has a different decision.')
    return current
  }
  const next = MediaResolutionStateSchema.parse({
    ...current,
    decisions: [...current.decisions, decision],
  })
  projectValidatedState(next)
  return next
}

/** Resolve references from their original candidate IDs every time; reversal never loses lineage. */
export function projectMediaResolution(input: unknown) {
  const state = MediaResolutionStateSchema.parse(input)
  const { representativeByCandidate, activeMergeIds } = projectValidatedState(state)
  const groups = new Map<string, string[]>()
  for (const [candidate, representative] of representativeByCandidate) {
    const members = groups.get(representative) ?? []
    members.push(candidate)
    groups.set(representative, members)
  }
  return {
    groups: [...groups].map(([representativeId, candidateIds]) => ({
      representativeId,
      candidateIds,
    })),
    references: [...representativeByCandidate].map(([candidateId, representativeId]) => ({
      candidateId,
      representativeId,
    })),
    activeMergeIds: [...activeMergeIds],
    decisionCount: state.decisions.length,
  }
}
