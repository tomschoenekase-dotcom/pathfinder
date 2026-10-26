export const AI_MODEL_KEYS = {
  AGENT_RUN: 'agent-run',
  ANALYTICS_TOPIC_CLASSIFIER: 'analytics-topic-classifier',
  ANALYTICS_WEEKLY_THEMES: 'analytics-weekly-themes',
  ANSWER_ANALYSIS: 'answer-analysis',
  CLIENT_TOCHI: 'client-tochi',
  COMPANY_BRAIN_RETRIEVAL_EVALUATION: 'company-brain-retrieval-evaluation',
  GUEST_ANSWER_ATTRIBUTION_EVALUATION: 'guest-answer-attribution-evaluation',
  GUEST_CHAT: 'guest-chat',
  GUEST_CHAT_DEEPSEEK_FLASH: 'guest-chat-deepseek-flash',
  GUEST_CHAT_DEEPSEEK_PRO: 'guest-chat-deepseek-pro',
  GUEST_CHAT_LUNA: 'guest-chat-luna',
  GUEST_CHAT_LUNA_REASONING: 'guest-chat-luna-reasoning',
  GUEST_CHAT_SOL: 'guest-chat-sol',
  GUEST_CHAT_SOL_FAST: 'guest-chat-sol-fast',
  GUEST_CHAT_TERRA_FAST: 'guest-chat-terra-fast',
  GUEST_CHAT_OPENAI: 'guest-chat-openai',
  WEEKLY_DIGEST: 'weekly-digest',
  WEEKLY_REPORT: 'weekly-report',
} as const

export type AiModelKey = (typeof AI_MODEL_KEYS)[keyof typeof AI_MODEL_KEYS]

export type AiTextProviderId = 'anthropic' | 'openai' | 'deepseek'

export type AiModelSpec = {
  provider: AiTextProviderId
  model: string
  costTier: 'ECONOMY' | 'STANDARD' | 'PREMIUM'
  maxOutputTokens: number
  /** OpenAI reasoning effort when the route pins one; otherwise the model's default effort. */
  reasoningEffort?: 'none' | 'minimal' | 'low'
  /** OpenAI processing tier the route requests; omitted means the project default (standard). */
  serviceTier?: 'fast'
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

function openAiMiniSpec(maxOutputTokens: number): AiModelSpec {
  return {
    provider: 'openai',
    model: 'gpt-5-mini-2025-08-07',
    costTier: 'ECONOMY',
    maxOutputTokens,
    timeoutMs: 15_000,
    maxAttempts: 2,
    maxInputUtf8Bytes: 180_000,
    maxBillableInputTokens: 200_000,
    pricingVersion: 'openai-public-2026-08-26',
    pricingUsdPerMillionTokens: {
      input: 0.25,
      output: 2,
      cacheWrite: 0.25,
      cacheRead: 0.025,
    },
  }
}

function openAiLunaSpec(maxOutputTokens: number): AiModelSpec {
  return {
    provider: 'openai',
    model: 'gpt-6-luna',
    costTier: 'ECONOMY',
    maxOutputTokens,
    timeoutMs: 15_000,
    maxAttempts: 2,
    maxInputUtf8Bytes: 180_000,
    maxBillableInputTokens: 200_000,
    pricingVersion: 'openai-standard-public-2026-09-22',
    pricingUsdPerMillionTokens: {
      input: 0.1,
      output: 0.5,
      cacheWrite: 0.125,
      cacheRead: 0.01,
    },
  }
}

// A stronger visitor-chat route: in a blind 186-turn test it was the only model with no factual
// errors, including opening-time reasoning ("11 AM, opens at noon") that Luna gets wrong.
// Standard public pricing with the adapter's default 30-minute cache-write lifetime.
function openAiSolSpec(maxOutputTokens: number): AiModelSpec {
  return {
    provider: 'openai',
    model: 'gpt-6.1-sol',
    costTier: 'STANDARD',
    maxOutputTokens,
    timeoutMs: 20_000,
    maxAttempts: 2,
    maxInputUtf8Bytes: 180_000,
    maxBillableInputTokens: 200_000,
    pricingVersion: 'openai-standard-public-2026-10-22',
    pricingUsdPerMillionTokens: {
      input: 2,
      output: 10,
      cacheWrite: 2.5,
      cacheRead: 0.1,
    },
  }
}

function deepSeekSpec(params: {
  model: 'deepseek-flash' | 'deepseek-v4-pro'
  costTier: AiModelSpec['costTier']
  maxOutputTokens: number
  inputUsdPerMillionTokens: number
  outputUsdPerMillionTokens: number
  cacheReadUsdPerMillionTokens: number
}): AiModelSpec {
  return {
    provider: 'deepseek',
    model: params.model,
    costTier: params.costTier,
    maxOutputTokens: params.maxOutputTokens,
    timeoutMs: 15_000,
    maxAttempts: 2,
    maxInputUtf8Bytes: 180_000,
    maxBillableInputTokens: 200_000,
    // Peak cache-miss rates are deliberately pinned so every reservation is
    // conservative; off-peak discounts must not lower a safety ceiling.
    pricingVersion: 'deepseek-2026-09-18-peak',
    pricingUsdPerMillionTokens: {
      input: params.inputUsdPerMillionTokens,
      output: params.outputUsdPerMillionTokens,
      cacheWrite: 0,
      cacheRead: params.cacheReadUsdPerMillionTokens,
    },
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
    costTier: 'ECONOMY',
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
  [AI_MODEL_KEYS.GUEST_CHAT]: haikuSpec(512),
  // Direct DeepSeek routes are explicit, fixed-endpoint visitor-chat canaries.
  // They remain disabled until a governed workload/client/venue override selects
  // one; callers can never supply a DeepSeek model ID or endpoint.
  [AI_MODEL_KEYS.GUEST_CHAT_DEEPSEEK_FLASH]: deepSeekSpec({
    model: 'deepseek-flash',
    costTier: 'ECONOMY',
    maxOutputTokens: 512,
    inputUsdPerMillionTokens: 0.3,
    outputUsdPerMillionTokens: 1.2,
    cacheReadUsdPerMillionTokens: 0.006,
  }),
  [AI_MODEL_KEYS.GUEST_CHAT_DEEPSEEK_PRO]: deepSeekSpec({
    model: 'deepseek-v4-pro',
    costTier: 'PREMIUM',
    maxOutputTokens: 512,
    inputUsdPerMillionTokens: 1.32,
    outputUsdPerMillionTokens: 3.96,
    cacheReadUsdPerMillionTokens: 0.044,
  }),
  // Explicit provider-diversity candidate. Anthropic remains the platform
  // default until a governed workload/client/venue override selects this key.
  // A ranking across a large venue (a reason per ride) can exceed 512 tokens; an incomplete
  // response becomes a fallback reply, so the guest route leaves room. Billing is per token used.
  [AI_MODEL_KEYS.GUEST_CHAT_LUNA]: openAiLunaSpec(1_024),
  // Luna that reasons briefly before answering: the same model and prices, with reasoning tokens
  // (billed as output) checking conditions and arithmetic first. Reasoning shares the output cap,
  // so it gets 2048 tokens, and a longer timeout. First text arrives after the reasoning.
  [AI_MODEL_KEYS.GUEST_CHAT_LUNA_REASONING]: {
    ...openAiLunaSpec(2_048),
    reasoningEffort: 'low',
    timeoutMs: 20_000,
  },
  // Reasoning tokens count against the output cap, so Sol gets more room than Luna.
  [AI_MODEL_KEYS.GUEST_CHAT_SOL]: openAiSolSpec(2_048),
  // The same Sol route on OpenAI Fast mode (service_tier "fast"): billed at twice the standard
  // rates. A 2026-10-26 replay of captured guest requests gave the same graded accuracy as
  // standard Sol with a much lower and steadier time to first text.
  [AI_MODEL_KEYS.GUEST_CHAT_SOL_FAST]: {
    ...openAiSolSpec(2_048),
    serviceTier: 'fast',
    pricingVersion: 'openai-fast-public-2026-10-26',
    pricingUsdPerMillionTokens: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  },
  // A faster, cheaper option on gpt-6.1-terra with Fast mode (2x the $1/$5 standard rates).
  // Effort is pinned to low: Terra does not accept "minimal". In the 2026-10-26 replay it was about
  // twice as fast as Sol but omitted more needed conditions, so it is not the default.
  [AI_MODEL_KEYS.GUEST_CHAT_TERRA_FAST]: {
    ...openAiSolSpec(2_048),
    model: 'gpt-6.1-terra',
    reasoningEffort: 'low',
    serviceTier: 'fast',
    pricingVersion: 'openai-fast-public-2026-10-26',
    pricingUsdPerMillionTokens: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  },
  [AI_MODEL_KEYS.GUEST_CHAT_OPENAI]: openAiMiniSpec(512),
  [AI_MODEL_KEYS.WEEKLY_DIGEST]: sonnetSpec(1_200),
  [AI_MODEL_KEYS.WEEKLY_REPORT]: sonnetSpec(1_800),
}

export function getAiModelSpec(modelKey: AiModelKey): AiModelSpec {
  return AI_MODEL_REGISTRY[modelKey]
}
