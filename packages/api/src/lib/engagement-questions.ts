export type EngagementQuestionForSelection = {
  id: string
  questionType: 'OPEN_ENDED' | 'MULTIPLE_CHOICE'
  prompt: string
  choiceOptions: string[]
  intensity: number
}

export type TenantEngagementMode = 'STOIC' | 'BALANCED' | 'CURIOUS'

// Per-turn probability of attempting engagement at all this turn, before
// deciding what to offer the AI. Unchanged by this packet.
const MODE_BASE_CHANCE: Record<TenantEngagementMode, number> = {
  STOIC: 0,
  BALANCED: 0.35,
  CURIOUS: 0.5,
}

/**
 * Rolls whether this turn gets an engagement attempt at all. Split out from
 * the weighted authored-question pick so CURIOUS mode can still invite the
 * AI to invent a question even when there are zero (or zero-weight) active
 * authored questions to weight-pick from.
 */
export function rollEngagementGate(
  mode: TenantEngagementMode,
  random: () => number = Math.random,
): boolean {
  const baseChance = MODE_BASE_CHANCE[mode]
  if (baseChance === 0) return false
  return random() < baseChance
}

/**
 * Weighted pick among active authored questions by `intensity`. Does not
 * consider mode - callers only invoke this after `rollEngagementGate` has
 * already passed.
 */
export function selectAuthoredQuestion(
  questions: EngagementQuestionForSelection[],
  random: () => number = Math.random,
): EngagementQuestionForSelection | null {
  if (questions.length === 0) return null

  const totalWeight = questions.reduce((sum, question) => sum + question.intensity, 0)
  if (totalWeight <= 0) return null

  let roll = random() * totalWeight
  for (const question of questions) {
    roll -= question.intensity
    if (roll <= 0) return question
  }

  return questions[questions.length - 1] ?? null
}
