import {
  generateTextForCapability,
  resolveAiWorkloadConfiguration,
  routeAiCapability,
  type AiAdmissionGuard,
  type AiBudgetGate,
  type AiUsageSink,
} from '@pathfinder/ai'
import {
  GuestAnswerClaimInputSchema,
  GuestAnswerEvidenceBundleSchema,
  type GuestAnswerEvidenceBundle,
} from '@pathfinder/contracts/guest-answer-attribution'
import { createVerifiedGuestAnswerAttribution } from '@pathfinder/contracts/guest-answer-attribution-node'
import { z } from 'zod'

export const GUEST_ANSWER_ATTRIBUTION_EVALUATOR_PROMPT_VERSION =
  'guest-answer-attribution-evaluator-v1' as const

const ProviderClaimsSchema = z
  .object({ claims: z.array(GuestAnswerClaimInputSchema).max(100) })
  .strict()

function parseProviderClaims(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u)?.[1]
  return ProviderClaimsSchema.parse(JSON.parse(fenced ?? text))
}

function buildEvaluationPayload(answer: string, evidence: GuestAnswerEvidenceBundle) {
  return {
    answer,
    answerHash: evidence.answerHash,
    evidenceSetHash: evidence.evidenceSetHash,
    sources: evidence.sources.map((source) => ({
      sourceId: source.sourceId,
      kind: source.kind,
      label: source.label,
      snapshot: source.snapshot,
      snapshotHash: source.snapshotHash,
    })),
  }
}

/**
 * Runs one bounded semantic attribution review over an exact, content-addressed answer/evidence
 * identity. The caller owns authorization, durable dispatch fencing, budget accounting, and any
 * persistence. The result is descriptive evidence only: it has no pass threshold, release effect,
 * visitor-visible effect, content mutation, or permission effect.
 */
export async function runProviderBackedGuestAnswerAttributionEvaluation(params: {
  answer: string
  evidence: GuestAnswerEvidenceBundle
  admissionGuard: AiAdmissionGuard
  budgetGate: AiBudgetGate
  usageSink: AiUsageSink
  invocationId?: string
  onBeforeFirstDispatch?: () => Promise<void>
  signal?: AbortSignal
}) {
  const answer = z.string().min(1).max(10_000).parse(params.answer)
  const evidence = GuestAnswerEvidenceBundleSchema.parse(params.evidence)
  // Verify every frozen hash before provider I/O, not only when parsing the response.
  createVerifiedGuestAnswerAttribution({
    answer,
    evidence,
    evaluator: {
      provider: 'preflight',
      model: 'integrity-check',
      configurationVersion: 'integrity-check-v1',
      promptVersion: GUEST_ANSWER_ATTRIBUTION_EVALUATOR_PROMPT_VERSION,
    },
    claims: [],
  })

  const configuration = resolveAiWorkloadConfiguration({
    workloadId: 'guest-answer-attribution-evaluation',
  })
  const route = routeAiCapability({
    workloadId: configuration.workloadId,
    configuration,
    capability: 'BACKGROUND_ANALYSIS',
    budgetPolicy: 'NORMAL',
    qualityPreference: 'PREMIUM',
  })
  const payload = buildEvaluationPayload(answer, evidence)
  const result = await generateTextForCapability({
    route,
    system: [
      {
        type: 'text',
        text: [
          'You are reviewing one Torchiko visitor answer against only the supplied frozen evidence.',
          'Annotate factual claims as SUPPORTED, UNSUPPORTED, or UNCERTAIN; annotate conversational or subjective spans as NON_FACTUAL.',
          'Use exact JavaScript string character offsets and exact answer substrings. Claims must not overlap.',
          'SUPPORTED requires one or more supplied sourceIds. NON_FACTUAL requires no sourceIds.',
          'Never invent a sourceId or use outside knowledge. If evidence is incomplete, choose UNCERTAIN.',
          'Return strict JSON only: {"claims":[{"start":number,"end":number,"text":string,"support":"SUPPORTED|UNSUPPORTED|UNCERTAIN|NON_FACTUAL","sourceIds":string[],"rationale":string}]}.',
          'This review supplies descriptive evidence only. Do not return pass/fail, severity, release, policy, or remediation decisions.',
        ].join(' '),
      },
    ],
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
    maxOutputTokens: configuration.maxOutputTokens ?? 4_000,
    timeoutMs: configuration.timeoutMs,
    maxAttempts: configuration.maxAttempts,
    admissionGuard: params.admissionGuard,
    budgetGate: params.budgetGate,
    requestBudgetCeilingE8Usd: configuration.requestBudgetCeilingE8Usd,
    usageSink: params.usageSink,
    parseResponse: parseProviderClaims,
    ...(params.invocationId ? { invocationId: params.invocationId } : {}),
    ...(params.onBeforeFirstDispatch
      ? { onBeforeFirstDispatch: params.onBeforeFirstDispatch }
      : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  })
  const attribution = createVerifiedGuestAnswerAttribution({
    answer,
    evidence,
    evaluator: {
      provider: result.provider,
      model: result.model,
      configurationVersion: configuration.configurationVersion,
      promptVersion: GUEST_ANSWER_ATTRIBUTION_EVALUATOR_PROMPT_VERSION,
    },
    claims: result.parsed.claims,
  })
  return { attribution, route: result.route, usage: result.usage }
}
