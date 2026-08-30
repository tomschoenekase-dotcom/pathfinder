import { db } from '../client'

export const EVALUATION_REGRESSION_ALERT_POLICY_KEY = 'evaluation-regression-alert-policy-v1'

export type EvaluationRegressionAlertPolicy = {
  version: 1
  minimumPassRateDrop: number
  errorPassRateDrop: number
}

type PlatformConfigClient = Pick<typeof db, 'platformConfig'>

/**
 * Reads an explicitly configured evaluation-alert policy. Absence, disabled or malformed state,
 * and read failure all keep automatic regression alerts dark. The worker must never substitute
 * an inferred quality or severity threshold.
 */
export async function getEvaluationRegressionAlertPolicy(
  client: PlatformConfigClient = db,
): Promise<EvaluationRegressionAlertPolicy | null> {
  try {
    const row = await client.platformConfig.findUnique({
      where: { key: EVALUATION_REGRESSION_ALERT_POLICY_KEY },
      select: { value: true },
    })
    if (typeof row?.value !== 'object' || row.value === null || Array.isArray(row.value))
      return null
    const value = row.value as Record<string, unknown>
    if (value.version !== 1 || value.enabled !== true) return null
    if (
      typeof value.minimumPassRateDrop !== 'number' ||
      !Number.isFinite(value.minimumPassRateDrop) ||
      value.minimumPassRateDrop <= 0 ||
      value.minimumPassRateDrop > 1 ||
      typeof value.errorPassRateDrop !== 'number' ||
      !Number.isFinite(value.errorPassRateDrop) ||
      value.errorPassRateDrop < value.minimumPassRateDrop ||
      value.errorPassRateDrop > 1
    )
      return null

    return {
      version: 1,
      minimumPassRateDrop: value.minimumPassRateDrop,
      errorPassRateDrop: value.errorPassRateDrop,
    }
  } catch {
    return null
  }
}
