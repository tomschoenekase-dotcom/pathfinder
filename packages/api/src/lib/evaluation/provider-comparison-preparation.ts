import { createHash } from 'node:crypto'

import { z } from 'zod'

import { AI_MODEL_KEYS, getAiModelSpec } from '@pathfinder/ai'

import { hashEvalCase } from './hash'
import {
  PROVIDER_COMPARISON_CASE_METRICS,
  PROVIDER_COMPARISON_CASES,
} from './provider-comparison-corpus'
import {
  PROVIDER_SOURCE_CLAIM_CASES,
  PROVIDER_SOURCE_CLAIM_CORPUS_HASH,
} from './provider-source-claim-corpus'

const routeKeys = [AI_MODEL_KEYS.GUEST_CHAT, AI_MODEL_KEYS.GUEST_CHAT_OPENAI] as const
const sourceClaimRouteKeys = [
  AI_MODEL_KEYS.COMPANY_BRAIN_RETRIEVAL_EVALUATION,
  AI_MODEL_KEYS.ANSWER_ANALYSIS,
] as const
const metricNames = [
  'factual-extraction',
  'temporal-error',
  'missed-entity',
  'escalation',
  'invalid-output',
] as const
const caseIds = PROVIDER_COMPARISON_CASES.map(({ caseId }) => caseId)
const caseHashes = PROVIDER_COMPARISON_CASES.map(hashEvalCase)
const corpusHash = createHash('sha256').update(caseHashes.join('\n')).digest('hex')
const MetricValueSchema = z.number().min(0).max(1).nullable()
const MetricsSchema = z
  .object({
    'factual-extraction': MetricValueSchema,
    'temporal-error': MetricValueSchema,
    'missed-entity': MetricValueSchema,
    escalation: MetricValueSchema,
    'invalid-output': MetricValueSchema,
  })
  .strict()

const ObservationSchema = z
  .object({
    routeKey: z.enum(routeKeys),
    status: z.enum(['UNAVAILABLE', 'OBSERVED']),
    corpusHash: z.literal(corpusHash),
    caseIds: z.array(z.string()).length(PROVIDER_COMPARISON_CASES.length),
    caseHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).length(caseHashes.length),
    metrics: MetricsSchema,
    latencyMs: z.number().finite().nonnegative().nullable(),
    estimatedCostUsd: z.number().finite().nonnegative().nullable(),
    invoiceCostUsd: z.number().finite().nonnegative().nullable(),
    limitation: z.string().trim().min(1).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = PROVIDER_COMPARISON_CASES.map(({ caseId }) => caseId)
    if (JSON.stringify(value.caseIds) !== JSON.stringify(expected)) {
      context.addIssue({
        code: 'custom',
        message: 'Observation must use the frozen corpus exactly',
        path: ['caseIds'],
      })
    }
    if (JSON.stringify(value.caseHashes) !== JSON.stringify(caseHashes)) {
      context.addIssue({
        code: 'custom',
        message: 'Observation case hashes must match the frozen corpus',
        path: ['caseHashes'],
      })
    }
    const values = metricNames.map((metric) => value.metrics[metric])
    if (
      value.status === 'UNAVAILABLE' &&
      (values.some((metric) => metric !== null) ||
        value.latencyMs !== null ||
        value.estimatedCostUsd !== null ||
        value.invoiceCostUsd !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Unavailable observations cannot contain quality scores',
        path: ['metrics'],
      })
    }
    if (value.status === 'OBSERVED' && values.some((metric) => typeof metric !== 'number')) {
      context.addIssue({
        code: 'custom',
        message: 'Observed comparisons require every metric',
        path: ['metrics'],
      })
    }
  })

export type ProviderComparisonObservation = z.infer<typeof ObservationSchema>

export function buildProviderComparisonPreparation() {
  return {
    version: 'provider-comparison-preparation-v1' as const,
    corpusHash,
    cases: PROVIDER_COMPARISON_CASES,
    caseMetrics: PROVIDER_COMPARISON_CASE_METRICS,
    routes: routeKeys.map((routeKey) => {
      const spec = getAiModelSpec(routeKey)
      return {
        routeKey,
        provider: spec.provider,
        model: spec.model,
        configuredPricingEstimate: {
          version: spec.pricingVersion,
          usdPerMillionTokens: spec.pricingUsdPerMillionTokens,
        },
        observation: ObservationSchema.parse({
          routeKey,
          status: 'UNAVAILABLE',
          corpusHash,
          caseIds,
          caseHashes,
          metrics: Object.fromEntries(metricNames.map((metric) => [metric, null])),
          latencyMs: null,
          estimatedCostUsd: null,
          invoiceCostUsd: null,
          limitation:
            'Prepared provider-dark; no provider execution or quality observation exists.',
        }),
      }
    }),
    modalityPreparation: {
      researchExtraction: {
        preparationStatus: 'PASS',
        modelQuality: 'UNKNOWN',
        corpusHash: PROVIDER_SOURCE_CLAIM_CORPUS_HASH,
        cases: PROVIDER_SOURCE_CLAIM_CASES,
        routes: sourceClaimRouteKeys.map((routeKey) => {
          const spec = getAiModelSpec(routeKey)
          return {
            routeKey,
            provider: spec.provider,
            model: spec.model,
            configuredPricingEstimate: {
              version: spec.pricingVersion,
              usdPerMillionTokens: spec.pricingUsdPerMillionTokens,
            },
          }
        }),
        observation: null,
        limitation:
          'Synthetic source/claim preparation only; no provider execution or route comparison result exists.',
      },
      realtimeVoice: {
        status: 'UNAVAILABLE',
        reason: 'No shared scored P11 provider corpus observation is retained.',
      },
      video: {
        status: 'UNAVAILABLE',
        reason: 'No shared scored P10 provider corpus observation is retained.',
      },
    },
    recommendation: null,
  }
}

export function validateProviderComparisonObservations(input: unknown[]) {
  const observations = input.map((item) => ObservationSchema.parse(item))
  if (new Set(observations.map(({ routeKey }) => routeKey)).size !== observations.length) {
    throw new Error('Comparison observations must have unique route keys')
  }
  return observations
}
