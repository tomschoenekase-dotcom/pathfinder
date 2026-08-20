import { describe, expect, it } from 'vitest'

import { normalizeTorchikoBrandText } from './brand'

describe('normalizeTorchikoBrandText', () => {
  it.each([
    ['PathFinder Staging QA', 'Torchiko Staging QA'],
    ['PATHFINDER setup', 'Torchiko setup'],
    ['Torchico Weekly Report', 'Torchiko Weekly Report'],
    ['pathfinder+qa@example.com', 'Torchiko+qa@example.com'],
  ])('normalizes retired visible branding in %s', (input, expected) => {
    expect(normalizeTorchikoBrandText(input)).toBe(expected)
  })

  it('leaves unrelated copy unchanged', () => {
    expect(normalizeTorchikoBrandText('Visitor guide')).toBe('Visitor guide')
  })
})
