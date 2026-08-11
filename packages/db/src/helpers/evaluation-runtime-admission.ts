import { db } from '../client'

export const EVALUATION_RUNTIME_GLOBAL_CONFIG_KEY = 'evaluation-runner-v1-global'

type PlatformConfigClient = Pick<typeof db, 'platformConfig'>

/** Durable cross-service rollout intent. Absence, malformed JSON, or a read
 * failure is disabled; process-local env gates remain independently required. */
export async function isEvaluationRuntimeDurablyEnabled(
  client: PlatformConfigClient = db,
): Promise<boolean> {
  try {
    const row = await client.platformConfig.findUnique({
      where: { key: EVALUATION_RUNTIME_GLOBAL_CONFIG_KEY },
      select: { value: true },
    })
    if (typeof row?.value !== 'object' || row.value === null || Array.isArray(row.value)) {
      return false
    }
    const value = row.value as Record<string, unknown>
    return value.version === 1 && value.enabled === true
  } catch {
    return false
  }
}
