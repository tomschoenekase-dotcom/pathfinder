export type DraftEvidence = { reference: string }
export type CopySource = {
  id: string
  version: string
  status: 'APPROVED' | 'PROPOSED' | 'INVALIDATED'
  allowedUses: readonly ('OUTREACH' | 'FOLLOW_UP' | 'PROPOSAL')[]
  provenance: string
}
export type DraftClaim = { text: string; evidenceReferences: readonly string[] }

export class ProspectCopyGroundingError extends Error {}

const consequentialClaims = [
  /\$\s*\d|\bpric(?:e|ing)\b|per month/iu,
  /\b(?:i|we) (?:visited|have visited|know) (?:your|the)\b/iu,
  /\b(?:customer|client)s? (?:saw|achieved|increased|reduced)\b/iu,
  /\b(?:guarantee|promise|will build)\b/iu,
]

export function validateProspectCopyHandoff(input: {
  subject: string
  textBody: string
  evidence: readonly DraftEvidence[]
  claims?: readonly DraftClaim[]
  copySources?: readonly CopySource[]
}) {
  const evidence = new Set(input.evidence.map((item) => item.reference))
  const claims = input.claims ?? []
  const copySources = input.copySources ?? []
  for (const source of copySources) {
    if (!source.id || !source.version || !source.provenance)
      throw new ProspectCopyGroundingError('Copy sources require identity, version, and provenance')
    if (source.status === 'INVALIDATED')
      throw new ProspectCopyGroundingError('Invalidated copy cannot be used in a draft')
    if (!source.allowedUses.includes('OUTREACH'))
      throw new ProspectCopyGroundingError('Copy source is not approved for outreach use')
  }
  for (const claim of claims) {
    if (!claim.text.trim() || !`${input.subject}\n${input.textBody}`.includes(claim.text))
      throw new ProspectCopyGroundingError('Declared claims must appear verbatim in the draft')
    if (
      claim.evidenceReferences.length === 0 ||
      claim.evidenceReferences.some((reference) => !evidence.has(reference))
    )
      throw new ProspectCopyGroundingError(
        'Every declared claim requires referenced draft evidence',
      )
  }
  const consequentialSpans = `${input.subject}\n${input.textBody}`
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((span) => span.trim())
    .filter((span) => span && consequentialClaims.some((pattern) => pattern.test(span)))
  for (const span of consequentialSpans) {
    if (!claims.some((claim) => claim.text === span))
      throw new ProspectCopyGroundingError(
        'Each pricing, relationship, result, or commitment sentence requires its own evidence-linked claim',
      )
  }
  return {
    evidenceReferences: [...evidence].sort(),
    claims: claims.map((claim) => ({
      ...claim,
      evidenceReferences: [...claim.evidenceReferences],
    })),
    copySources: copySources.map((source) => ({ ...source, allowedUses: [...source.allowedUses] })),
    reviewRequired: true as const,
    sendAuthorized: false as const,
    warnings: copySources.some((source) => source.status === 'PROPOSED')
      ? ['Draft uses proposed copy that still needs founder approval.']
      : [],
    heuristicLimit:
      'Automated checks cover declared high-risk language only; human review remains required for truth and tone.',
  }
}
