import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMocks = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../client', () => ({
  db: {
    $transaction: databaseMocks.transaction,
  },
}))

import { checkDatabaseConnection } from './health'

beforeEach(() => {
  databaseMocks.executeRaw.mockReset().mockResolvedValue(1)
  databaseMocks.queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }])
  databaseMocks.transaction.mockReset().mockImplementation(async (callback) =>
    callback({
      $executeRaw: databaseMocks.executeRaw,
      $queryRaw: databaseMocks.queryRaw,
    }),
  )
})

describe('database health probe', () => {
  it('bounds pool acquisition and transaction execution and applies a local statement timeout', async () => {
    await expect(checkDatabaseConnection(2_000)).resolves.toEqual([{ '?column?': 1 }])

    expect(databaseMocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 487,
      timeout: 1_463,
    })
    expect(databaseMocks.executeRaw).toHaveBeenCalledOnce()
    expect(databaseMocks.executeRaw.mock.calls[0]?.[1]).toBe('1463')
    expect(databaseMocks.queryRaw).toHaveBeenCalledOnce()
    expect(databaseMocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      databaseMocks.queryRaw.mock.invocationCallOrder[0]!,
    )
  })

  it.each([0, -1, 1.5, 3, Number.NaN, 2_147_483_648])(
    'rejects an invalid timeout before opening a transaction: %s',
    async (timeoutMs) => {
      await expect(checkDatabaseConnection(timeoutMs)).rejects.toThrow(
        /supported PostgreSQL integer/,
      )
      expect(databaseMocks.transaction).not.toHaveBeenCalled()
    },
  )
})
