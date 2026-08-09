import { afterEach, describe, expect, it, vi } from 'vitest'

import { logger, setErrorMonitor } from './logger'

describe('logger error monitor', () => {
  afterEach(() => setErrorMonitor())

  it('reports an error exactly once after writing the local log', () => {
    const sink = vi.fn()
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    setErrorMonitor(sink)

    logger.error({ action: 'test.failure', error: 'local detail', tenantId: 'tenant-one' })

    expect(stdout).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'test.failure', error: 'local detail' }),
    )
    stdout.mockRestore()
  })

  it('does not let a monitoring failure escape', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    setErrorMonitor(() => {
      throw new Error('monitor unavailable')
    })

    expect(() => logger.error({ action: 'test.failure', error: 'original' })).not.toThrow()
    stdout.mockRestore()
  })
})
