import { describe, expect, it, vi } from 'vitest'

import {
  selectEngagementQuestion,
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

describe('selectEngagementQuestion', () => {
  it('never asks in stoic mode', () => {
    expect(selectEngagementQuestion('STOIC', questions, () => 0)).toBeNull()
  })

  it('returns null for an empty question list', () => {
    expect(selectEngagementQuestion('CURIOUS', [], () => 0)).toBeNull()
  })

  it('returns null when the base-chance gate fails without consuming a second roll', () => {
    const random = vi.fn(() => 0.35)

    expect(selectEngagementQuestion('BALANCED', questions, random)).toBeNull()
    expect(random).toHaveBeenCalledTimes(1)
  })

  it('uses intensity weights when the gate passes', () => {
    expect(
      selectEngagementQuestion(
        'BALANCED',
        questions,
        vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0.1),
      ),
    ).toEqual(questions[0])
    expect(
      selectEngagementQuestion(
        'BALANCED',
        questions,
        vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0.95),
      ),
    ).toEqual(questions[1])
  })
})
