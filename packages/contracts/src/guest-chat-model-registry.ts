/** Pure public-route definitions: no SDK clients, environment reads, or provider calls.
 * Add one route entry (and a regression test) for an existing provider. Projections below
 * feed execution, contracts, routing, deployment validation, and operator choices.
 * A new provider still needs its adapter and provider policy implemented separately.
 */
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

export function haikuSpec(maxOutputTokens: number, timeoutMs = 10_000): AiModelSpec {
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

type GuestSelection = {
  order: number
  inputAliases: readonly string[]
  title: string
  alsoKnownAs: readonly string[]
  description: string
  recommended: boolean
}
type GuestRouteDefinition = {
  key: string
  spec: AiModelSpec
  publicOrder: number
  environmentDefaultAllowed: boolean
  runtimeDefaultAllowed: boolean
  defaultFallback: { enabled: boolean; modelKeys: readonly string[] }
  selection?: GuestSelection
}

export const GUEST_CHAT_ROUTE_DEFINITIONS = {
  GUEST_CHAT: {
    key: 'guest-chat',
    spec: haikuSpec(512),
    publicOrder: 0,
    environmentDefaultAllowed: true,
    runtimeDefaultAllowed: false,
    defaultFallback: { enabled: false, modelKeys: [] },
    selection: {
      order: 5,
      inputAliases: [],
      title: 'Platform built-in (Haiku)',
      alsoKnownAs: ['Haiku', 'built-in'],
      description:
        'The registry fallback route on Anthropic Haiku. Economy tier and not the measured choice for current guides.',
      recommended: false,
    },
  },
  GUEST_CHAT_DEEPSEEK_FLASH: {
    key: 'guest-chat-deepseek-flash',
    spec: deepSeekSpec({
      model: 'deepseek-flash',
      costTier: 'ECONOMY',
      maxOutputTokens: 512,
      inputUsdPerMillionTokens: 0.3,
      outputUsdPerMillionTokens: 1.2,
      cacheReadUsdPerMillionTokens: 0.006,
    }),
    publicOrder: 7,
    environmentDefaultAllowed: false,
    runtimeDefaultAllowed: false,
    defaultFallback: { enabled: false, modelKeys: [] },
  },
  GUEST_CHAT_DEEPSEEK_PRO: {
    key: 'guest-chat-deepseek-pro',
    spec: deepSeekSpec({
      model: 'deepseek-v4-pro',
      costTier: 'PREMIUM',
      maxOutputTokens: 512,
      inputUsdPerMillionTokens: 1.32,
      outputUsdPerMillionTokens: 3.96,
      cacheReadUsdPerMillionTokens: 0.044,
    }),
    publicOrder: 8,
    environmentDefaultAllowed: false,
    runtimeDefaultAllowed: false,
    defaultFallback: { enabled: false, modelKeys: [] },
  },
  GUEST_CHAT_LUNA: {
    key: 'guest-chat-luna',
    spec: openAiLunaSpec(1_024),
    publicOrder: 2,
    environmentDefaultAllowed: true,
    runtimeDefaultAllowed: true,
    defaultFallback: { enabled: false, modelKeys: [] },
    selection: {
      order: 3,
      inputAliases: ['luna', 'Luna'],
      title: 'Luna',
      alsoKnownAs: ['Luna', 'GPT-6 Luna'],
      description:
        'Smaller, cheaper OpenAI model. Weaker on long or conditional answers; use only for a measured cost reason.',
      recommended: false,
    },
  },
  GUEST_CHAT_LUNA_REASONING: {
    key: 'guest-chat-luna-reasoning',
    spec: { ...openAiLunaSpec(2_048), reasoningEffort: 'low', timeoutMs: 20_000 },
    publicOrder: 3,
    environmentDefaultAllowed: true,
    runtimeDefaultAllowed: true,
    defaultFallback: { enabled: false, modelKeys: [] },
    selection: {
      order: 4,
      inputAliases: [],
      title: 'Luna + brief reasoning',
      alsoKnownAs: ['Luna reasoning'],
      description:
        'Luna that reasons briefly before answering. Cheaper than Sol, with slower first text.',
      recommended: false,
    },
  },
  GUEST_CHAT_SOL: {
    key: 'guest-chat-sol',
    spec: openAiSolSpec(2_048),
    publicOrder: 4,
    environmentDefaultAllowed: true,
    runtimeDefaultAllowed: true,
    defaultFallback: { enabled: false, modelKeys: [] },
    selection: {
      order: 2,
      inputAliases: [],
      title: 'Sol (standard speed)',
      alsoKnownAs: ['Sol standard', 'Sol without Fast'],
      description:
        'Same model and accuracy as Sol + Fast at half the price, with slower and less steady first text.',
      recommended: false,
    },
  },
  GUEST_CHAT_SOL_FAST: {
    key: 'guest-chat-sol-fast',
    spec: {
      ...openAiSolSpec(2_048),
      serviceTier: 'fast',
      pricingVersion: 'openai-fast-public-2026-10-26',
      pricingUsdPerMillionTokens: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
    },
    publicOrder: 5,
    environmentDefaultAllowed: true,
    runtimeDefaultAllowed: true,
    defaultFallback: { enabled: false, modelKeys: [] },
    selection: {
      order: 0,
      inputAliases: ['sol', 'Sol'],
      title: 'Sol + Fast',
      alsoKnownAs: ['Sol', 'Sol Fast', '6.1 Sol', 'GPT-6.1 Sol'],
      description:
        'Recommended default. Best graded accuracy in testing, with low and steady time to first text. Billed at twice the standard Sol rate.',
      recommended: true,
    },
  },
  GUEST_CHAT_TERRA_FAST: {
    key: 'guest-chat-terra-fast',
    spec: {
      ...openAiSolSpec(2_048),
      model: 'gpt-6.1-terra',
      reasoningEffort: 'low',
      serviceTier: 'fast',
      pricingVersion: 'openai-fast-public-2026-10-26',
      pricingUsdPerMillionTokens: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
    },
    publicOrder: 6,
    environmentDefaultAllowed: true,
    runtimeDefaultAllowed: true,
    defaultFallback: { enabled: false, modelKeys: [] },
    selection: {
      order: 1,
      inputAliases: ['terra', 'Terra'],
      title: 'Terra + Fast',
      alsoKnownAs: ['Terra', 'Terra Fast', '6.1 Terra', 'GPT-6.1 Terra'],
      description:
        'About twice as fast and cheaper than Sol + Fast, but it omitted more needed details (conditions, hours) in testing. Only when speed matters more than completeness.',
      recommended: false,
    },
  },
  GUEST_CHAT_OPENAI: {
    key: 'guest-chat-openai',
    spec: openAiMiniSpec(512),
    publicOrder: 1,
    environmentDefaultAllowed: false,
    runtimeDefaultAllowed: false,
    defaultFallback: { enabled: false, modelKeys: [] },
  },
} as const satisfies Readonly<Record<string, GuestRouteDefinition>>

type GuestDefinition =
  (typeof GUEST_CHAT_ROUTE_DEFINITIONS)[keyof typeof GUEST_CHAT_ROUTE_DEFINITIONS]
export type GuestChatModelKey = GuestDefinition['key']
type OperatorDefinition = Extract<GuestDefinition, { selection: GuestSelection }>
export type OperatorGuestChatModelKey = OperatorDefinition['key']

export const GUEST_CHAT_MODEL_KEYS = Object.fromEntries(
  Object.entries(GUEST_CHAT_ROUTE_DEFINITIONS).map(([constant, definition]) => [
    constant,
    definition.key,
  ]),
) as {
  readonly [K in keyof typeof GUEST_CHAT_ROUTE_DEFINITIONS]: (typeof GUEST_CHAT_ROUTE_DEFINITIONS)[K]['key']
}

export const GUEST_CHAT_MODEL_SPECS = Object.fromEntries(
  Object.values(GUEST_CHAT_ROUTE_DEFINITIONS).map(({ key, spec }) => [key, spec]),
) as Readonly<Record<GuestChatModelKey, AiModelSpec>>

const publicDefinitions = Object.values(GUEST_CHAT_ROUTE_DEFINITIONS).sort(
  (a, b) => a.publicOrder - b.publicOrder,
)
export const GUEST_CHAT_PUBLIC_ROUTE_KEYS = publicDefinitions.map(({ key }) => key) as [
  GuestChatModelKey,
  ...GuestChatModelKey[],
]
export const GUEST_CHAT_ENVIRONMENT_DEFAULT_KEYS = publicDefinitions
  .filter((route) => route.environmentDefaultAllowed)
  .map(({ key }) => key) as [GuestChatModelKey, ...GuestChatModelKey[]]
export const GUEST_CHAT_RUNTIME_DEFAULT_KEYS = publicDefinitions
  .filter((route) => route.runtimeDefaultAllowed)
  .map(({ key }) => key) as [GuestChatModelKey, ...GuestChatModelKey[]]
export const GUEST_CHAT_DEFAULT_FALLBACKS = Object.fromEntries(
  publicDefinitions.map(({ key, defaultFallback }) => [key, defaultFallback]),
) as unknown as Readonly<
  Record<
    GuestChatModelKey,
    { readonly enabled: boolean; readonly modelKeys: readonly GuestChatModelKey[] }
  >
>

const operatorDefinitions = publicDefinitions
  .filter((route): route is OperatorDefinition => 'selection' in route)
  .sort((a, b) => a.selection.order - b.selection.order)
export const OPERATOR_GUEST_MODEL_SELECTIONS = Object.fromEntries(
  operatorDefinitions.map(({ key, selection }) => {
    const { order: _order, ...metadata } = selection
    void _order
    return [key, metadata]
  }),
) as { readonly [D in OperatorDefinition as D['key']]: Omit<D['selection'], 'order'> }

export const OPERATOR_GUEST_MODEL_KEYS = operatorDefinitions.map(({ key }) => key) as [
  OperatorGuestChatModelKey,
  ...OperatorGuestChatModelKey[],
]
type GuestSelectionInputKey =
  | OperatorGuestChatModelKey
  | OperatorDefinition['selection']['inputAliases'][number]
export const OPERATOR_GUEST_MODEL_INPUT_KEYS = [
  ...OPERATOR_GUEST_MODEL_KEYS,
  ...operatorDefinitions.flatMap(
    (route): readonly GuestSelectionInputKey[] => route.selection.inputAliases,
  ),
] as [GuestSelectionInputKey, ...GuestSelectionInputKey[]]
