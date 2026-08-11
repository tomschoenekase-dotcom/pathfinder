import { describe, expect, it, vi } from 'vitest'

import {
  EVALUATION_RUNTIME_GLOBAL_CONFIG_KEY,
  isEvaluationRuntimeDurablyEnabled,
} from './evaluation-runtime-admission'

describe('evaluation runtime durable admission', () => {
  it('requires the exact durable enabled contract', async () => {
    const findUnique = vi.fn().mockResolvedValue({ value: { version: 1, enabled: true } })
    await expect(
      isEvaluationRuntimeDurablyEnabled({ platformConfig: { findUnique } } as never),
    ).resolves.toBe(true)
    expect(findUnique).toHaveBeenCalledWith({
      where: { key: EVALUATION_RUNTIME_GLOBAL_CONFIG_KEY },
      select: { value: true },
    })
  })

  it.each([null, {}, { version: 1, enabled: false }, { version: 2, enabled: true }])(
    'fails closed for %j',
    async (value) => {
      const client = { platformConfig: { findUnique: vi.fn().mockResolvedValue({ value }) } }
      await expect(isEvaluationRuntimeDurablyEnabled(client as never)).resolves.toBe(false)
    },
  )

  it('fails closed when durable state cannot be read', async () => {
    const client = {
      platformConfig: { findUnique: vi.fn().mockRejectedValue(new Error('unavailable')) },
    }
    await expect(isEvaluationRuntimeDurablyEnabled(client as never)).resolves.toBe(false)
  })
})
