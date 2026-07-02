export type EngagementQuestionForSelection = {
  id: string
  questionType: 'OPEN_ENDED' | 'MULTIPLE_CHOICE'
  prompt: string
  choiceOptions: string[]
  intensity: number
}

export type TenantEngagementMode = 'STOIC' | 'BALANCED' | 'CURIOUS'

const MODE_BASE_CHANCE: Record<TenantEngagementMode, number> = {
  STOIC: 0,
  BALANCED: 0.35,
  CURIOUS: 0.5,
}

export function selectEngagementQuestion(
  mode: TenantEngagementMode,
  questions: EngagementQuestionForSelection[],
  random: () => number = Math.random,
): EngagementQuestionForSelection | null {
  if (questions.length === 0) return null

  const baseChance = MODE_BASE_CHANCE[mode]
  if (baseChance === 0 || random() >= baseChance) return null

  const totalWeight = questions.reduce((sum, question) => sum + question.intensity, 0)
  if (totalWeight <= 0) return null

  let roll = random() * totalWeight
  for (const question of questions) {
    roll -= question.intensity
    if (roll <= 0) return question
  }

  return questions[questions.length - 1] ?? null
}
