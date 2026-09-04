import { db } from '../client'

export const EVALUATION_RUNTIME_GLOBAL_CONFIG_KEY = 'evaluation-runner-v1-global'

type PlatformConfigClient = Pick<typeof db, 'platformConfig'>

export const EVALUATION_AUTHORIZED_PROVIDERS = ['openai', 'anthropic'] as const
export const MAX_EVALUATION_AUTHORIZATION_BUDGET_E8_USD = 410_000_000n
export type EvaluationAuthorizedProvider = (typeof EVALUATION_AUTHORIZED_PROVIDERS)[number]

export type EvaluationRuntimeAuthorization = {
  version: 2
  enabled: true
  authorizationId: string
  authorizedAt: Date
  expiresAt: Date
  maxBudgetE8Usd: bigint
  allowedProviders: EvaluationAuthorizedProvider[]
}

export function parseEvaluationRuntimeAuthorization(
  input: unknown,
  now = new Date(),
): EvaluationRuntimeAuthorization | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  if (
    value.version !== 2 ||
    value.enabled !== true ||
    typeof value.authorizationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value.authorizationId,
    ) ||
    typeof value.authorizedAt !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    typeof value.maxBudgetE8Usd !== 'string' ||
    !/^\d+$/u.test(value.maxBudgetE8Usd) ||
    BigInt(value.maxBudgetE8Usd) <= 0n ||
    BigInt(value.maxBudgetE8Usd) > MAX_EVALUATION_AUTHORIZATION_BUDGET_E8_USD ||
    !Array.isArray(value.allowedProviders) ||
    value.allowedProviders.length === 0 ||
    value.allowedProviders.length > EVALUATION_AUTHORIZED_PROVIDERS.length ||
    new Set(value.allowedProviders).size !== value.allowedProviders.length ||
    value.allowedProviders.some(
      (provider) =>
        typeof provider !== 'string' ||
        !EVALUATION_AUTHORIZED_PROVIDERS.includes(provider as EvaluationAuthorizedProvider),
    )
  )
    return null
  const authorizedAt = new Date(value.authorizedAt)
  const expiresAt = new Date(value.expiresAt)
  if (
    !Number.isFinite(authorizedAt.getTime()) ||
    !Number.isFinite(expiresAt.getTime()) ||
    authorizedAt > now ||
    expiresAt <= authorizedAt ||
    expiresAt <= now
  )
    return null
  return {
    version: 2,
    enabled: true,
    authorizationId: value.authorizationId,
    authorizedAt,
    expiresAt,
    maxBudgetE8Usd: BigInt(value.maxBudgetE8Usd),
    allowedProviders: [...new Set(value.allowedProviders)] as EvaluationAuthorizedProvider[],
  }
}

export async function getEvaluationRuntimeAuthorization(
  client: PlatformConfigClient = db,
  now = new Date(),
): Promise<EvaluationRuntimeAuthorization | null> {
  try {
    const row = await client.platformConfig.findUnique({
      where: { key: EVALUATION_RUNTIME_GLOBAL_CONFIG_KEY },
      select: { value: true },
    })
    return parseEvaluationRuntimeAuthorization(row?.value, now)
  } catch {
    return null
  }
}

/** Durable cross-service rollout intent. Absence, malformed JSON, or a read
 * failure is disabled; process-local env gates remain independently required. */
export async function isEvaluationRuntimeDurablyEnabled(
  client: PlatformConfigClient = db,
): Promise<boolean> {
  return (await getEvaluationRuntimeAuthorization(client)) !== null
}

/** Binds provider admission to the same expiring authorization window frozen
 * into the run. Re-enabling later cannot revive work from an older window. */
export async function evaluationRuntimeAuthorizationAllowsRun(
  runConfigSnapshot: unknown,
  modelProvider: string,
  client: PlatformConfigClient = db,
): Promise<boolean> {
  const current = await getEvaluationRuntimeAuthorization(client)
  if (!current || !current.allowedProviders.includes(modelProvider as EvaluationAuthorizedProvider))
    return false
  if (
    typeof runConfigSnapshot !== 'object' ||
    runConfigSnapshot === null ||
    Array.isArray(runConfigSnapshot)
  )
    return false
  const frozen = (runConfigSnapshot as Record<string, unknown>).authorization
  if (typeof frozen !== 'object' || frozen === null || Array.isArray(frozen)) return false
  const record = frozen as Record<string, unknown>
  const frozenProviders = record.allowedProviders
  return (
    record.authorizationId === current.authorizationId &&
    record.authorizedAt === current.authorizedAt.toISOString() &&
    record.expiresAt === current.expiresAt.toISOString() &&
    record.maxBudgetE8Usd === current.maxBudgetE8Usd.toString() &&
    Array.isArray(frozenProviders) &&
    frozenProviders.length === current.allowedProviders.length &&
    current.allowedProviders.every((provider) => frozenProviders.includes(provider))
  )
}
