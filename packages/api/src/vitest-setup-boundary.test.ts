import { describe, expect, it } from 'vitest'

describe('API unit-test environment boundary', () => {
  it('unconditionally replaces inherited database targets with synthetic loopback URLs', () => {
    expect(process.env.DATABASE_URL).toBe(
      'postgresql://pathfinder_test:pathfinder_test@127.0.0.1:5432/pathfinder_test',
    )
    expect(process.env.DIRECT_DATABASE_URL).toBe(process.env.DATABASE_URL)
    expect(new URL(process.env.DATABASE_URL!).hostname).toBe('127.0.0.1')
  })
})
