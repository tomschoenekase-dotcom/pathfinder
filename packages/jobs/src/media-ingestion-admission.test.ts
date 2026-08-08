import { describe, expect, it, vi } from 'vitest'

import {
  configureMediaIngestionGlobalConcurrency,
  MEDIA_INGESTION_GLOBAL_CONCURRENCY,
} from './media-ingestion-admission'

describe('media ingestion admission configuration', () => {
  it('sets and verifies the one-job global ceiling', async () => {
    const setGlobalConcurrency = vi.fn(async () => 1)
    const getGlobalConcurrency = vi.fn(async () => MEDIA_INGESTION_GLOBAL_CONCURRENCY)

    await expect(
      configureMediaIngestionGlobalConcurrency({
        getGlobalConcurrency,
        setGlobalConcurrency,
      }),
    ).resolves.toBeUndefined()

    expect(setGlobalConcurrency).toHaveBeenCalledWith(MEDIA_INGESTION_GLOBAL_CONCURRENCY)
    expect(getGlobalConcurrency).toHaveBeenCalledOnce()
    expect(setGlobalConcurrency.mock.invocationCallOrder[0]).toBeLessThan(
      getGlobalConcurrency.mock.invocationCallOrder[0]!,
    )
  })

  it('fails startup if Redis does not retain the exact ceiling', async () => {
    await expect(
      configureMediaIngestionGlobalConcurrency({
        setGlobalConcurrency: vi.fn(async () => 1),
        getGlobalConcurrency: vi.fn(async () => null),
      }),
    ).rejects.toThrow('Media ingestion global concurrency could not be verified')
  })
})
