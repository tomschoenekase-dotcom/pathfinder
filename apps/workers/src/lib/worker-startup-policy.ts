export const WORKER_EXECUTION_FLAGS = [
  'WORKER_SCHEDULERS_ENABLED',
  'OUTBOUND_PROVIDER_WORKERS_ENABLED',
  'CRM_BACKGROUND_WORKERS_ENABLED',
  'EMBEDDING_DISPATCH_ENABLED',
  'GENERATION_DISPATCH_ENABLED',
  'GENERATION_RECOVERY_ENABLED',
  'EVALUATION_RUNNER_ENABLED',
] as const

const DEPENDENT_EXECUTION_FLAGS = WORKER_EXECUTION_FLAGS.filter(
  (flag) =>
    flag !== 'OUTBOUND_PROVIDER_WORKERS_ENABLED' && flag !== 'CRM_BACKGROUND_WORKERS_ENABLED',
)

export type WorkerStartupEnvironment = Partial<
  Record<(typeof WORKER_EXECUTION_FLAGS)[number] | 'RAILWAY_ENVIRONMENT', string>
>

export type WorkerStartupPolicy = {
  mode: 'provider-enabled' | 'crm-only' | 'provider-disabled'
  requiredEnvironmentKeys: string[]
}

export function resolveWorkerStartupPolicy(
  environment: WorkerStartupEnvironment,
): WorkerStartupPolicy {
  for (const flag of WORKER_EXECUTION_FLAGS) {
    const value = environment[flag]
    if (value !== undefined && value !== 'true' && value !== 'false') {
      throw new Error(`${flag} must be exactly true or false for workers`)
    }
  }

  if (environment.RAILWAY_ENVIRONMENT === 'production') {
    for (const flag of WORKER_EXECUTION_FLAGS) {
      if (environment[flag] === undefined || environment[flag] === '') {
        throw new Error(`${flag} must be explicitly set for production workers`)
      }
    }
  }

  const providerEnabled = environment.OUTBOUND_PROVIDER_WORKERS_ENABLED === 'true'
  const crmBackgroundEnabled = environment.CRM_BACKGROUND_WORKERS_ENABLED === 'true'
  if (!providerEnabled) {
    const conflictingFlag = DEPENDENT_EXECUTION_FLAGS.find((flag) => environment[flag] === 'true')
    if (conflictingFlag) {
      throw new Error(
        `${conflictingFlag} cannot be enabled while outbound provider workers are disabled`,
      )
    }
  }

  return providerEnabled
    ? {
        mode: 'provider-enabled',
        requiredEnvironmentKeys: ['REDIS_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
      }
    : crmBackgroundEnabled
      ? {
          mode: 'crm-only',
          requiredEnvironmentKeys: ['REDIS_URL', 'DATABASE_URL', 'DIRECT_DATABASE_URL'],
        }
      : { mode: 'provider-disabled', requiredEnvironmentKeys: ['REDIS_URL'] }
}
