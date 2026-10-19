import { describe, expect, it } from 'vitest'

import { reasoningEffort } from './openai-text'

describe('Luna reasoning effort setting', () => {
  it('keeps Luna at none unless low is selected, and never changes other models', () => {
    expect(reasoningEffort('gpt-6-luna', {})).toBe('none')
    expect(reasoningEffort('gpt-6-luna', { OPENAI_LUNA_REASONING_EFFORT: 'high' })).toBe('none')
    expect(reasoningEffort('gpt-6-luna', { OPENAI_LUNA_REASONING_EFFORT: ' Low ' })).toBe('low')
    expect(reasoningEffort('gpt-6.1-sol', { OPENAI_LUNA_REASONING_EFFORT: 'low' })).toBe('low')
    expect(reasoningEffort('gpt-6.1-sol', {})).toBe('low')
    expect(reasoningEffort('gpt-5-mini', { OPENAI_LUNA_REASONING_EFFORT: 'low' })).toBe('minimal')
  })
})
