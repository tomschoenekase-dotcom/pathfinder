import { createHash } from 'node:crypto'

import { canonicalEvaluationJson, type CanonicalJsonValue } from './evaluation'
import {
  createGuestAnswerAttribution,
  GUEST_ANSWER_EVIDENCE_VERSION,
  type GuestAnswerAttribution,
  type GuestAnswerAttributionInput,
  GuestAnswerEvidenceBundleSchema,
  type GuestAnswerEvidenceBundle,
  type GuestAnswerEvidenceSource,
} from './guest-answer-attribution'
import { GUEST_CHAT_PROMPT_VERSION } from './prompt-contract'

export type GuestAnswerEvidenceSourceInput = {
  sourceId: string
  kind: GuestAnswerEvidenceSource['kind']
  label: string
  rank?: number | null
  snapshot: unknown
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function frozenSnapshot(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('Answer evidence source is not JSON serializable')
  return canonicalEvaluationJson(JSON.parse(serialized) as CanonicalJsonValue)
}

export function buildGuestAnswerEvidenceBundle(input: {
  assistantResponse: string
  staticSystemPrompt: string
  dynamicSystemPrompt: string
  routeConfigurationVersion?: string
  sources: readonly GuestAnswerEvidenceSourceInput[]
}): GuestAnswerEvidenceBundle {
  const sources = input.sources.map((source) => {
    const snapshot = frozenSnapshot(source.snapshot)
    return {
      sourceId: source.sourceId,
      kind: source.kind,
      label: source.label,
      rank: source.rank ?? null,
      snapshot,
      snapshotHash: hash(snapshot),
    }
  })
  const system = {
    staticPart: input.staticSystemPrompt,
    dynamicPart: input.dynamicSystemPrompt,
  }
  const systemPromptHash = hash(
    canonicalEvaluationJson({
      promptContractVersion: GUEST_CHAT_PROMPT_VERSION,
      system,
    }),
  )
  const routeConfigurationVersion = input.routeConfigurationVersion?.trim() || null
  const evidenceSetHash = hash(
    canonicalEvaluationJson({
      promptContractVersion: GUEST_CHAT_PROMPT_VERSION,
      systemPromptHash,
      routeConfigurationVersion,
      sources,
    }),
  )

  return GuestAnswerEvidenceBundleSchema.parse({
    schemaVersion: GUEST_ANSWER_EVIDENCE_VERSION,
    promptContractVersion: GUEST_CHAT_PROMPT_VERSION,
    answerHash: hash(input.assistantResponse),
    systemPromptHash,
    evidenceSetHash,
    routeConfigurationVersion,
    system,
    sources,
  })
}

/** Recomputes every content-addressed boundary before evidence is trusted by an evaluator. */
export function verifyGuestAnswerEvidenceBundle(input: {
  assistantResponse: string
  evidence: GuestAnswerEvidenceBundle
}): boolean {
  const evidence = GuestAnswerEvidenceBundleSchema.parse(input.evidence)
  if (hash(input.assistantResponse) !== evidence.answerHash) return false
  if (evidence.sources.some((source) => hash(source.snapshot) !== source.snapshotHash)) return false
  const expectedSystemPromptHash = hash(
    canonicalEvaluationJson({
      promptContractVersion: evidence.promptContractVersion,
      system: evidence.system,
    }),
  )
  if (expectedSystemPromptHash !== evidence.systemPromptHash) return false
  const expectedEvidenceSetHash = hash(
    canonicalEvaluationJson({
      promptContractVersion: evidence.promptContractVersion,
      systemPromptHash: evidence.systemPromptHash,
      routeConfigurationVersion: evidence.routeConfigurationVersion,
      sources: evidence.sources,
    }),
  )
  return expectedEvidenceSetHash === evidence.evidenceSetHash
}

/**
 * Runtime boundary for attribution ingestion. Hash verification proves identity and integrity;
 * semantic correctness still belongs to the attributed evaluator.
 */
export function createVerifiedGuestAnswerAttribution(
  input: GuestAnswerAttributionInput,
): GuestAnswerAttribution {
  if (
    !verifyGuestAnswerEvidenceBundle({
      assistantResponse: input.answer,
      evidence: input.evidence,
    })
  ) {
    throw new Error('Guest answer attribution evidence failed content-address verification')
  }
  return createGuestAnswerAttribution(input)
}
