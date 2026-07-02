import { describe, expect, it, vi } from 'vitest'

import {
  rollEngagementGate,
  selectAuthoredQuestion,
  type EngagementQuestionForSelection,
} from './engagement-questions'

const questions: EngagementQuestionForSelection[] = [
  {
    id: 'question_1',
    questionType: 'OPEN_ENDED',
    prompt: 'Ask about wayfinding.',
    choiceOptions: [],
    intensity: 1,
  },
  {
    id: 'question_2',
    questionType: 'MULTIPLE_CHOICE',
    prompt: 'Ask about favorite part.',
    choiceOptions: ['exhibit', 'food court'],
    intensity: 4,
  },
]

describe('rollEngagementGate', () => {
  it('never passes in stoic mode, without consuming a roll', () => {
    const random = vi.fn(() => 0)
    expect(rollEngagementGate('STOIC', random)).toBe(false)
    expect(random).not.toHaveBeenCalled()
  })

  it('passes when the roll is under the mode base chance', () => {
    expect(rollEngagementGate('BALANCED', () => 0)).toBe(true)
    expect(rollEngagementGate('CURIOUS', () => 0.49)).toBe(true)
  })

  it('fails when the roll is at or above the mode base chance', () => {
    expect(rollEngagementGate('BALANCED', () => 0.35)).toBe(false)
    expect(rollEngagementGate('CURIOUS', () => 0.5)).toBe(false)
  })
})

describe('selectAuthoredQuestion', () => {
  it('returns null for an empty question list without consuming a roll', () => {
    const random = vi.fn(() => 0)
    expect(selectAuthoredQuestion([], random)).toBeNull()
    expect(random).not.toHaveBeenCalled()
  })

  it('uses intensity weights', () => {
    expect(selectAuthoredQuestion(questions, vi.fn().mockReturnValueOnce(0.1))).toEqual(
      questions[0],
    )
    expect(selectAuthoredQuestion(questions, vi.fn().mockReturnValueOnce(0.95))).toEqual(
      questions[1],
    )
  })
})
