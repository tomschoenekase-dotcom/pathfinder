import { prepareGuestQueryEvidence } from './guest-query-evidence'
import type { GuestQuerySource } from './guest-query-source'

/** Local rehearsal only; no tenant flag or production configuration change. */
export function guestQueryChatExperimentEnabled(input: {
  nodeEnv: string | undefined
  enabled: string | undefined
  experienceScope: string
  nativePath: string
}) {
  return (
    (input.nodeEnv === 'development' || input.nodeEnv === 'test') &&
    input.enabled === '1' &&
    input.experienceScope === 'PUBLIC' &&
    (input.nativePath === 'LEGACY' || input.nativePath === 'DARK')
  )
}

/** Interpret once through the caller's accounted gateway; invalid plans never retry it. */
export async function prepareGuestChatQueryExperiment(input: {
  source: GuestQuerySource
  question: string
  interpret: (request: { system: string; question: string }) => Promise<string>
}) {
  const source = structuredClone(input.source)
  let interpretationCompleted = false
  let prepared: Awaited<ReturnType<typeof prepareGuestQueryEvidence>>
  try {
    prepared = await prepareGuestQueryEvidence({
      source,
      question: input.question,
      interpret: async (request) => {
        const text = await input.interpret(request)
        interpretationCompleted = true
        return text
      },
    })
  } catch (error) {
    // Provider, admission and accounting errors propagate to existing turn failure handling.
    if (!interpretationCompleted) throw error
    return { status: 'BASELINE' as const, reason: 'INVALID_PLAN_OR_EVIDENCE' as const }
  }
  if (prepared.status !== 'READY')
    return { status: 'BASELINE' as const, reason: 'UNSUPPORTED_PLAN' as const }
  if (
    prepared.trace.plan.status !== 'QUERY' ||
    prepared.trace.plan.query.predicates.some(
      (predicate) =>
        predicate.field === 'feature' ||
        (predicate.field === 'product' && !prepared.canonicalAuthority),
    )
  )
    return { status: 'BASELINE' as const, reason: 'UNSUPPORTED_LEGACY_FIELD' as const }
  if (!prepared.evidence.completePage || !prepared.evidence.completeContext)
    return { status: 'BASELINE' as const, reason: 'INCOMPLETE_SOURCE_CONTEXT' as const }

  const admittedKeys = new Set([
    ...prepared.evidence.includedKeys,
    ...prepared.evidence.includedContextKeys,
  ])
  return {
    status: 'READY' as const,
    sourceVersion: source.version,
    prompt: prepared.evidence.prompt,
    places: source.directory.places.filter((row) => admittedKeys.has(`place:${row.id}`)),
    knowledge: source.directory.knowledge.filter((row) => admittedKeys.has(`knowledge:${row.id}`)),
    canonicalSources: prepared.canonicalSources,
    partial:
      !prepared.evidence.completePage ||
      !prepared.evidence.completeContext ||
      prepared.result.hasMore ||
      !prepared.result.exhaustiveAnswerEligible,
    // Bounded execution metadata, not a claim that hashes reconstruct a source snapshot.
    summary: {
      version: 'guest-query-chat-experiment-v1',
      sourceVersion: source.version,
      questionSha256: prepared.trace.questionSha256,
      plannerPromptSha256: prepared.trace.plannerPromptSha256,
      query: prepared.trace.plan.query,
      mode: prepared.result.mode,
      coverage: prepared.result.coverage,
      inventoryScope: prepared.result.inventoryScope,
      knownMatchCount: prepared.result.knownMatchCount,
      unknownCandidateCount: prepared.result.unknownCandidateCount,
      exactEligibleCount: prepared.result.exactEligibleCount,
      hasMore: prepared.result.hasMore,
      omittedPageRecordCount: prepared.evidence.omittedKeys.length,
      omittedContextCount: prepared.evidence.omittedContextKeys.length,
      canonicalAuthority: prepared.canonicalAuthority,
      policyCoverage: prepared.policyCoverage,
    },
  }
}

export type GuestChatQueryExperiment = Extract<
  Awaited<ReturnType<typeof prepareGuestChatQueryExperiment>>,
  { status: 'READY' }
>

/** The old prompt still contains baseline bodies; a new source must not contradict them. */
export function guestQuerySourcesAgree(
  baseline: readonly { id: string }[],
  current: readonly { id: string }[],
) {
  const previous = new Map(baseline.map((row) => [row.id, row]))
  return current.every((row) => {
    const prior = previous.get(row.id)
    if (!prior) return true
    const priorFields = prior as Record<string, unknown>
    return Object.entries(row).every(
      ([key, value]) => JSON.stringify(priorFields[key]) === JSON.stringify(value),
    )
  })
}
