import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}))

vi.mock('../client', () => ({
  db: {
    $queryRaw: databaseMocks.queryRaw,
  },
}))

import { checkDatabaseConnection } from './health'

beforeEach(() => {
  databaseMocks.queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }])
})

describe('database health probe', () => {
  it('checks the ordinary read path without an interactive transaction', async () => {
    await expect(checkDatabaseConnection(2_000)).resolves.toEqual([{ '?column?': 1 }])
    expect(databaseMocks.queryRaw).toHaveBeenCalledOnce()
  })

  it.each([0, -1, 1.5, 3, Number.NaN, 2_147_483_648])(
    'rejects an invalid timeout before querying: %s',
    async (timeoutMs) => {
      await expect(checkDatabaseConnection(timeoutMs)).rejects.toThrow(
        /supported PostgreSQL integer/,
      )
      expect(databaseMocks.queryRaw).not.toHaveBeenCalled()
    },
  )
})
