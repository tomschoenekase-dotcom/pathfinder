import { describe, expect, it, vi } from 'vitest'

import {
  EVALUATION_REGRESSION_ALERT_POLICY_KEY,
  getEvaluationRegressionAlertPolicy,
} from './evaluation-regression-policy'

function client(value: unknown) {
  return {
    platformConfig: {
      findUnique: vi.fn().mockResolvedValue(value === undefined ? null : { value }),
    },
  }
}

describe('evaluation regression alert policy', () => {
  it('returns only an explicit enabled and ordered threshold policy', async () => {
    const configured = client({
      version: 1,
      enabled: true,
      minimumPassRateDrop: 0.08,
      errorPassRateDrop: 0.2,
    })
    await expect(getEvaluationRegressionAlertPolicy(configured as never)).resolves.toEqual({
      version: 1,
      minimumPassRateDrop: 0.08,
      errorPassRateDrop: 0.2,
    })
    expect(configured.platformConfig.findUnique).toHaveBeenCalledWith({
      where: { key: EVALUATION_REGRESSION_ALERT_POLICY_KEY },
      select: { value: true },
    })
  })

  it.each([
    undefined,
    null,
    [],
    { version: 1, enabled: false, minimumPassRateDrop: 0.05, errorPassRateDrop: 0.15 },
    { version: 1, enabled: true, minimumPassRateDrop: 0, errorPassRateDrop: 0.15 },
    { version: 1, enabled: true, minimumPassRateDrop: 0.2, errorPassRateDrop: 0.1 },
    { version: 2, enabled: true, minimumPassRateDrop: 0.05, errorPassRateDrop: 0.15 },
  ])('fails dark for absent, disabled, or malformed policy %#', async (value) => {
    await expect(getEvaluationRegressionAlertPolicy(client(value) as never)).resolves.toBeNull()
  })

  it('fails dark when policy storage is unavailable', async () => {
    const unavailable = {
      platformConfig: { findUnique: vi.fn().mockRejectedValue(new Error('unavailable')) },
    }
    await expect(getEvaluationRegressionAlertPolicy(unavailable as never)).resolves.toBeNull()
  })
})
