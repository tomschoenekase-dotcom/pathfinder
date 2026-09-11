import { z } from 'zod'

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u)
const stableId = z
  .string()
  .min(1)
  .max(191)
  .refine((value) => !/[\p{Cc}]/u.test(value), 'Identifiers must not contain control characters')

export const MediaEvidenceLocatorSchema = z
  .object({
    tenantId: stableId,
    projectId: stableId,
    uploadAttemptId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    sourceId: z
      .string()
      .min(1)
      .max(500)
      .refine(
        (value) => !/[\p{Cc}]/u.test(value),
        'Identifiers must not contain control characters',
      ),
    sourceSha256: sha256,
    observationIndex: z.number().int().min(0).max(49_999),
    observationSha256: sha256,
  })
  .strict()

export type MediaEvidenceLocator = z.infer<typeof MediaEvidenceLocatorSchema>

export const MediaEvidenceScopeSchema = MediaEvidenceLocatorSchema.pick({
  tenantId: true,
  projectId: true,
  uploadAttemptId: true,
})
export type MediaEvidenceScope = z.infer<typeof MediaEvidenceScopeSchema>

export function mediaEvidenceLocatorId(locator: MediaEvidenceLocator): string {
  const parsed = MediaEvidenceLocatorSchema.parse(locator)
  return `media-evidence-v1:${JSON.stringify([
    parsed.tenantId,
    parsed.projectId,
    parsed.uploadAttemptId,
    parsed.sourceId,
    parsed.sourceSha256,
    String(parsed.observationIndex),
    parsed.observationSha256,
  ])}`
}

export function createMediaEvidenceLocatorIndex(
  scopeInput: MediaEvidenceScope,
  locatorInputs: readonly MediaEvidenceLocator[],
): ReadonlySet<string> {
  const scope = MediaEvidenceScopeSchema.parse(scopeInput)
  const ids = new Set<string>()
  for (const input of locatorInputs) {
    const locator = MediaEvidenceLocatorSchema.parse(input)
    if (
      locator.tenantId !== scope.tenantId ||
      locator.projectId !== scope.projectId ||
      locator.uploadAttemptId !== scope.uploadAttemptId
    ) {
      throw new Error(
        'Media evidence belongs to a different tenant, project, or upload generation.',
      )
    }
    const id = mediaEvidenceLocatorId(locator)
    if (ids.has(id)) throw new Error('Media evidence locators must be unique.')
    ids.add(id)
  }
  return ids
}

const identityScheme = z.enum(['inventory_id', 'qr_payload', 'canonical_uri'])

export const MediaEntityCandidateSchema = z
  .object({
    candidateId: stableId,
    label: z.string().min(1).max(200),
    kind: z.string().min(1).max(100),
    evidence: z.array(MediaEvidenceLocatorSchema).min(1).max(100),
    identifiers: z
      .array(z.object({ scheme: identityScheme, value: z.string().min(1).max(200) }).strict())
      .max(25)
      .default([]),
    contextKeys: z.array(z.string().min(1).max(200)).max(50).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.identifiers.map((item) => item.scheme)).size !== value.identifiers.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'A candidate must resolve conflicting or repeated identifier schemes before matching.',
      })
    }
    if (new Set(value.evidence.map(mediaEvidenceLocatorId)).size !== value.evidence.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Candidate evidence must be unique.',
      })
    }
    const [first] = value.evidence
    if (
      first &&
      value.evidence.some(
        (item) =>
          item.tenantId !== first.tenantId ||
          item.projectId !== first.projectId ||
          item.uploadAttemptId !== first.uploadAttemptId,
      )
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A candidate cannot mix evidence scopes or upload generations.',
      })
  })

export type MediaEntityCandidate = z.infer<typeof MediaEntityCandidateSchema>

export type MediaEntityMatchAssessment =
  | { disposition: 'PROPOSE_MERGE'; reasons: string[] }
  | { disposition: 'KEEP_DISTINCT'; reasons: string[] }
  | { disposition: 'REVIEW_HYPOTHESIS'; reasons: string[] }

export function assessMediaEntityMatch(
  leftInput: MediaEntityCandidate,
  rightInput: MediaEntityCandidate,
): MediaEntityMatchAssessment {
  const left = MediaEntityCandidateSchema.parse(leftInput)
  const right = MediaEntityCandidateSchema.parse(rightInput)
  const leftScope = left.evidence[0]!
  const rightScope = right.evidence[0]!
  if (
    leftScope.tenantId !== rightScope.tenantId ||
    leftScope.projectId !== rightScope.projectId ||
    leftScope.uploadAttemptId !== rightScope.uploadAttemptId
  ) {
    return {
      disposition: 'KEEP_DISTINCT',
      reasons: ['Candidate evidence scopes or upload generations differ.'],
    }
  }
  if (left.candidateId === right.candidateId) {
    return { disposition: 'KEEP_DISTINCT', reasons: ['Candidate identity must not self-merge.'] }
  }
  if (left.kind !== right.kind) {
    return { disposition: 'KEEP_DISTINCT', reasons: ['Entity kinds differ.'] }
  }
  const leftByScheme = new Map(left.identifiers.map((item) => [item.scheme, item.value]))
  const conflictingScheme = right.identifiers.find(
    (item) => leftByScheme.has(item.scheme) && leftByScheme.get(item.scheme) !== item.value,
  )
  if (conflictingScheme) {
    return {
      disposition: 'KEEP_DISTINCT',
      reasons: [`Conflicting ${conflictingScheme.scheme} identifiers.`],
    }
  }
  const rightIdentifiers = new Set(right.identifiers.map((item) => `${item.scheme}:${item.value}`))
  const sharedIdentifiers = left.identifiers.filter((item) =>
    rightIdentifiers.has(`${item.scheme}:${item.value}`),
  )
  if (sharedIdentifiers.length > 0) {
    return {
      disposition: 'PROPOSE_MERGE',
      reasons: sharedIdentifiers.map((item) => `Shared ${item.scheme} identifier.`),
    }
  }
  const rightContext = new Set(right.contextKeys)
  const sharedContext = new Set(left.contextKeys.filter((item) => rightContext.has(item)))
  const leftSources = new Set(left.evidence.map((item) => item.sourceId))
  const distinctSources = right.evidence.every((item) => !leftSources.has(item.sourceId))
  if (sharedContext.size >= 2 && distinctSources) {
    return {
      disposition: 'REVIEW_HYPOTHESIS',
      reasons: [
        'Multiple context keys agree across distinct sources, but no identifier proves identity.',
      ],
    }
  }
  return {
    disposition: 'KEEP_DISTINCT',
    reasons: ['A matching label alone is not identity evidence.'],
  }
}

export const MediaEntityMergeProposalSchema = z
  .object({
    proposalId: stableId,
    candidateIds: z.array(stableId).min(2).max(100),
    evidenceLocatorIds: z.array(z.string().min(1).max(2_500)).min(1).max(100),
    sourceIdentities: z
      .array(
        z
          .object({
            candidateId: stableId,
            evidenceLocatorIds: z.array(z.string().min(1).max(2_500)).min(1).max(100),
          })
          .strict(),
      )
      .min(2)
      .max(100),
    status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'REVERTED']),
    canonicalEntityId: stableId.optional(),
    revision: z.number().int().min(0),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.candidateIds).size !== value.candidateIds.length)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Merge candidates must be unique.' })
    const mappedCandidates = value.sourceIdentities.map((item) => item.candidateId)
    if (
      new Set(mappedCandidates).size !== mappedCandidates.length ||
      value.candidateIds.some((id) => !mappedCandidates.includes(id)) ||
      mappedCandidates.some((id) => !value.candidateIds.includes(id))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Merge source identities must preserve every candidate exactly once.',
      })
    if (value.status === 'ACCEPTED' && !value.canonicalEntityId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Accepted merges require the reviewed canonical entity ID.',
      })
    if (value.status === 'REVERTED' && !value.canonicalEntityId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Reverted merges retain the canonical entity ID for audit and reversal.',
      })
  })

export function validateMediaMergeAuthority(
  proposal: z.input<typeof MediaEntityMergeProposalSchema>,
  candidates: readonly MediaEntityCandidate[],
  authority: {
    scope: MediaEvidenceScope
    availableLocatorIds: ReadonlySet<string>
    canonicalEntityIds: ReadonlySet<string>
  },
) {
  const parsed = MediaEntityMergeProposalSchema.parse(proposal)
  const candidateIndex = new Map(
    candidates.map((candidate) => {
      const value = MediaEntityCandidateSchema.parse(candidate)
      return [value.candidateId, value] as const
    }),
  )
  if (candidateIndex.size !== candidates.length)
    throw new Error('Reviewed candidates must be unique.')
  const union = new Set<string>()
  for (const source of parsed.sourceIdentities) {
    const candidate = candidateIndex.get(source.candidateId)
    if (!candidate) throw new Error('Merge candidate is outside the reviewed media project.')
    const exact = createMediaEvidenceLocatorIndex(authority.scope, candidate.evidence)
    if (
      new Set(source.evidenceLocatorIds).size !== source.evidenceLocatorIds.length ||
      source.evidenceLocatorIds.length !== exact.size ||
      source.evidenceLocatorIds.some(
        (id) => !exact.has(id) || !authority.availableLocatorIds.has(id),
      )
    ) {
      throw new Error('Merge source identities must retain the exact available candidate evidence.')
    }
    for (const id of exact) union.add(id)
  }
  if (
    parsed.evidenceLocatorIds.length !== union.size ||
    new Set(parsed.evidenceLocatorIds).size !== union.size ||
    parsed.evidenceLocatorIds.some((id) => !union.has(id))
  ) {
    throw new Error('Merge evidence must equal the retained candidate source identities.')
  }
  if (parsed.canonicalEntityId && !authority.canonicalEntityIds.has(parsed.canonicalEntityId)) {
    throw new Error('Merge canonical entity is outside the reviewed venue authority.')
  }
  return parsed
}

export const MediaRelationProposalSchema = z
  .object({
    proposalId: stableId,
    fromCandidateId: stableId,
    toCandidateId: stableId,
    kind: z.enum(['CONTAINS', 'ADJACENT', 'COVISIBLE', 'TRAVERSABLE']),
    evidenceLocatorIds: z.array(z.string().min(1).max(2_500)).min(1).max(100),
    basis: z.enum([
      'visual_overlap',
      'explicit_containment',
      'explicit_path',
      'doorway',
      'map_route',
    ]),
    confidence: z.enum(['confirmed', 'probable', 'unverified']),
    reviewStatus: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'REVERTED']),
    canonicalFromLocationId: z.string().uuid().optional(),
    canonicalToLocationId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.fromCandidateId === value.toCandidateId)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Relation endpoints must differ.' })
    if (new Set(value.evidenceLocatorIds).size !== value.evidenceLocatorIds.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Relation evidence must be unique.',
      })
    if (
      value.kind === 'TRAVERSABLE' &&
      !['explicit_path', 'doorway', 'map_route'].includes(value.basis)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Traversability requires explicit path, doorway, or map-route evidence.',
      })
    if (
      value.reviewStatus === 'ACCEPTED' &&
      (!value.canonicalFromLocationId || !value.canonicalToLocationId)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Accepted relations require exact canonical location endpoints.',
      })
    if (
      value.reviewStatus === 'ACCEPTED' &&
      value.canonicalFromLocationId === value.canonicalToLocationId
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Accepted canonical relation endpoints must differ.',
      })
  })

export function validateMediaRelationEvidence(
  proposal: z.input<typeof MediaRelationProposalSchema>,
  availableLocatorIds: ReadonlySet<string>,
) {
  const parsed = MediaRelationProposalSchema.parse(proposal)
  const missing = parsed.evidenceLocatorIds.filter((id) => !availableLocatorIds.has(id))
  if (missing.length > 0) throw new Error('Relation references unavailable media evidence.')
  return parsed
}

export function validateMediaRelationAuthority(
  proposal: z.input<typeof MediaRelationProposalSchema>,
  authority: {
    availableLocatorIds: ReadonlySet<string>
    candidateIds: ReadonlySet<string>
    canonicalLocationIds: ReadonlySet<string>
  },
) {
  const parsed = validateMediaRelationEvidence(proposal, authority.availableLocatorIds)
  if (
    !authority.candidateIds.has(parsed.fromCandidateId) ||
    !authority.candidateIds.has(parsed.toCandidateId)
  )
    throw new Error('Relation endpoint candidate is outside the reviewed media project.')
  if (
    parsed.reviewStatus === 'ACCEPTED' &&
    (!authority.canonicalLocationIds.has(parsed.canonicalFromLocationId!) ||
      !authority.canonicalLocationIds.has(parsed.canonicalToLocationId!))
  )
    throw new Error('Relation canonical endpoint is outside the reviewed venue authority.')
  return parsed
}
