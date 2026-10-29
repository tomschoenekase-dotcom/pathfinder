import {
  GUEST_CHAT_MODEL_KEYS,
  GUEST_CHAT_MODEL_SPECS,
  haikuSpec,
  type AiModelSpec,
} from '@pathfinder/contracts/guest-chat-model-registry'
export type { AiModelSpec, AiTextProviderId } from '@pathfinder/contracts/guest-chat-model-registry'

export const AI_MODEL_KEYS = {
  AGENT_RUN: 'agent-run',
  ANALYTICS_TOPIC_CLASSIFIER: 'analytics-topic-classifier',
  ANALYTICS_WEEKLY_THEMES: 'analytics-weekly-themes',
  ANSWER_ANALYSIS: 'answer-analysis',
  CLIENT_TOCHI: 'client-tochi',
  COMPANY_BRAIN_RETRIEVAL_EVALUATION: 'company-brain-retrieval-evaluation',
  GUEST_ANSWER_ATTRIBUTION_EVALUATION: 'guest-answer-attribution-evaluation',
  ...GUEST_CHAT_MODEL_KEYS,
  WEEKLY_DIGEST: 'weekly-digest',
  WEEKLY_REPORT: 'weekly-report',
} as const

export type AiModelKey = (typeof AI_MODEL_KEYS)[keyof typeof AI_MODEL_KEYS]

function sonnetSpec(maxOutputTokens: number): AiModelSpec {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    costTier: 'PREMIUM',
    maxOutputTokens,
    timeoutMs: 30_000,
    // BullMQ owns retries for fail-closed background jobs. Avoid multiplying
    // provider calls inside each queue attempt.
    maxAttempts: 1,
    maxInputUtf8Bytes: 180_000,
    maxBillableInputTokens: 200_000,
    pricingVersion: 'anthropic-public-2026-08-07',
    pricingUsdPerMillionTokens: {
      input: 3,
      output: 15,
      cacheWrite: 3.75,
      cacheRead: 0.3,
    },
  }
}

export const AI_MODEL_REGISTRY: Readonly<Record<AiModelKey, AiModelSpec>> = {
  [AI_MODEL_KEYS.AGENT_RUN]: sonnetSpec(1_800),
  [AI_MODEL_KEYS.ANALYTICS_TOPIC_CLASSIFIER]: haikuSpec(1_024, 30_000),
  [AI_MODEL_KEYS.ANALYTICS_WEEKLY_THEMES]: haikuSpec(1_024, 30_000),
  [AI_MODEL_KEYS.ANSWER_ANALYSIS]: sonnetSpec(1_500),
  // Private client-portal helper. It receives a small client-visible projection,
  // has no browsing/general-agent tools, and is expected to answer concisely.
  [AI_MODEL_KEYS.CLIENT_TOCHI]: haikuSpec(384, 8_000),
  // Bounded, explicitly invoked grounding evaluation. This is not an online
  // customer workflow and must still pass the caller's admission/budget gates.
  [AI_MODEL_KEYS.COMPANY_BRAIN_RETRIEVAL_EVALUATION]: haikuSpec(900, 30_000),
  // Bounded, explicitly invoked semantic review of one frozen guest answer and its
  // exact evidence bundle. Execution remains policy-, admission-, and budget-gated.
  [AI_MODEL_KEYS.GUEST_ANSWER_ATTRIBUTION_EVALUATION]: sonnetSpec(4_000),
  ...GUEST_CHAT_MODEL_SPECS,
  [AI_MODEL_KEYS.WEEKLY_DIGEST]: sonnetSpec(1_200),
  [AI_MODEL_KEYS.WEEKLY_REPORT]: sonnetSpec(1_800),
}

export function getAiModelSpec(modelKey: AiModelKey): AiModelSpec {
  return AI_MODEL_REGISTRY[modelKey]
}
