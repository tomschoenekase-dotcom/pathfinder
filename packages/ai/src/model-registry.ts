export const AI_MODEL_KEYS = {
  AGENT_RUN: 'agent-run',
  ANALYTICS_TOPIC_CLASSIFIER: 'analytics-topic-classifier',
  ANALYTICS_WEEKLY_THEMES: 'analytics-weekly-themes',
  ANSWER_ANALYSIS: 'answer-analysis',
  CLIENT_TOCHI: 'client-tochi',
  GUEST_CHAT: 'guest-chat',
  WEEKLY_DIGEST: 'weekly-digest',
  WEEKLY_REPORT: 'weekly-report',
} as const

export type AiModelKey = (typeof AI_MODEL_KEYS)[keyof typeof AI_MODEL_KEYS]

export type AiModelSpec = {
  provider: 'anthropic'
  model: string
  maxOutputTokens: number
  timeoutMs: number
  maxAttempts: number
  maxInputUtf8Bytes: number
  maxBillableInputTokens: number
  pricingVersion: string
  pricingUsdPerMillionTokens: {
    input: number
    output: number
    cacheWrite: number
    cacheRead: number
  }
}

const HAIKU_PRICING = {
  input: 1,
  output: 5,
  cacheWrite: 1.25,
  cacheRead: 0.1,
} as const

function haikuSpec(maxOutputTokens: number, timeoutMs = 10_000): AiModelSpec {
  return {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    maxOutputTokens,
    timeoutMs,
    maxAttempts: 2,
    maxInputUtf8Bytes: 180_000,
    maxBillableInputTokens: 200_000,
    pricingVersion: 'anthropic-public-2026-08-07',
    // Anthropic Claude API list prices verified 2026-08-07. Keep pricing
    // versioned with code; cost is an estimate, never an invoice amount.
    pricingUsdPerMillionTokens: HAIKU_PRICING,
  }
}

function sonnetSpec(maxOutputTokens: number): AiModelSpec {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
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
  [AI_MODEL_KEYS.GUEST_CHAT]: haikuSpec(512),
  [AI_MODEL_KEYS.WEEKLY_DIGEST]: sonnetSpec(1_200),
  [AI_MODEL_KEYS.WEEKLY_REPORT]: sonnetSpec(1_800),
}

export function getAiModelSpec(modelKey: AiModelKey): AiModelSpec {
  return AI_MODEL_REGISTRY[modelKey]
}
