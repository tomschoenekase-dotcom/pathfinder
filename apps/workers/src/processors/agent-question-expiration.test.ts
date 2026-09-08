import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  expire: vi.fn(),
  info: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({ logger: { info: mocks.info } }))
vi.mock('@pathfinder/db', () => ({ expireAgentQuestionsAction: mocks.expire }))

import { processAgentQuestionExpiration } from './agent-question-expiration'

describe('processAgentQuestionExpiration', () => {
  beforeEach(() => vi.clearAllMocks())

  it('invokes only the bounded canonical expiration action and logs aggregate counts', async () => {
    const result = { scanned: 14, expired: 3, skipped: 11 }
    mocks.expire.mockResolvedValue(result)

    await expect(processAgentQuestionExpiration()).resolves.toEqual(result)

    expect(mocks.expire).toHaveBeenCalledWith({ limit: 100 })
    expect(mocks.info).toHaveBeenCalledWith({
      action: 'workers.agent-question-expiration.completed',
      ...result,
    })
  })

  it('does not emit a completion record when canonical expiration fails', async () => {
    mocks.expire.mockRejectedValue(new Error('database unavailable'))

    await expect(processAgentQuestionExpiration()).rejects.toThrow('database unavailable')
    expect(mocks.info).not.toHaveBeenCalled()
  })
})
