import { describe, expect, it } from 'vitest'

import { safeEmployeeReturnPath } from './employee-auth-return'

describe('safeEmployeeReturnPath', () => {
  const employeePath =
    '/pathfinder-staging-qa-venue/layer/123e4567-e89b-42d3-a456-426614174999/chat'

  it('keeps an exact employee chat path', () => {
    expect(safeEmployeeReturnPath(employeePath)).toBe(employeePath)
  })

  it.each([
    undefined,
    'https://evil.example/steal',
    '//evil.example/steal',
    `${employeePath}?next=https://evil.example`,
    `${employeePath}#fragment`,
    '/ordinary-public-route',
  ])('falls back for an unsafe return target', (value) => {
    expect(safeEmployeeReturnPath(value)).toBe('/')
  })

  it('uses only the first query value', () => {
    expect(safeEmployeeReturnPath([employeePath, 'https://evil.example'])).toBe(employeePath)
  })
})
