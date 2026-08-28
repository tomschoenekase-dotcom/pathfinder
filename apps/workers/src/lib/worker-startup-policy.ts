export const WORKER_EXECUTION_FLAGS = [
  'WORKER_SCHEDULERS_ENABLED',
  'OUTBOUND_PROVIDER_WORKERS_ENABLED',
  'CRM_BACKGROUND_WORKERS_ENABLED',
  'INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED',
  'EMBEDDING_DISPATCH_ENABLED',
  'GENERATION_DISPATCH_ENABLED',
  'GENERATION_RECOVERY_ENABLED',
  'EVALUATION_RUNNER_ENABLED',
  'VENUE_MEDIA_DERIVATIVE_WORKERS_ENABLED',
  'FOUNDER_ABSENCE_OBSERVER_ENABLED',
] as const

const DEPENDENT_EXECUTION_FLAGS = WORKER_EXECUTION_FLAGS.filter(
  (flag) =>
    flag !== 'OUTBOUND_PROVIDER_WORKERS_ENABLED' &&
    flag !== 'CRM_BACKGROUND_WORKERS_ENABLED' &&
    flag !== 'INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED' &&
    flag !== 'EVALUATION_RUNNER_ENABLED' &&
    flag !== 'VENUE_MEDIA_DERIVATIVE_WORKERS_ENABLED' &&
    flag !== 'FOUNDER_ABSENCE_OBSERVER_ENABLED',
)

export type WorkerStartupEnvironment = Partial<
  Record<(typeof WORKER_EXECUTION_FLAGS)[number] | 'RAILWAY_ENVIRONMENT', string>
>

export type WorkerStartupPolicy = {
  mode:
    | 'provider-enabled'
    | 'crm-only'
    | 'intake-upload-verification-only'
    | 'evaluation-only'
    | 'venue-media-derivative-only'
    | 'founder-absence-observer-only'
    | 'provider-disabled'
  requiredEnvironmentKeys: string[]
  intakeUploadVerificationEnabled: boolean
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
  const intakeUploadVerificationEnabled =
    environment.INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED === 'true'
  const evaluationRunnerEnabled = environment.EVALUATION_RUNNER_ENABLED === 'true'
  const venueMediaDerivativeEnabled = environment.VENUE_MEDIA_DERIVATIVE_WORKERS_ENABLED === 'true'
  const founderAbsenceObserverEnabled = environment.FOUNDER_ABSENCE_OBSERVER_ENABLED === 'true'
  if (
    founderAbsenceObserverEnabled &&
    (providerEnabled ||
      crmBackgroundEnabled ||
      intakeUploadVerificationEnabled ||
      evaluationRunnerEnabled)
  ) {
    throw new Error(
      'FOUNDER_ABSENCE_OBSERVER_ENABLED can run only by itself or with the venue media derivative runtime',
    )
  }
  if (!providerEnabled) {
    const conflictingFlag = DEPENDENT_EXECUTION_FLAGS.find((flag) => environment[flag] === 'true')
    if (conflictingFlag) {
      throw new Error(
        `${conflictingFlag} cannot be enabled while outbound provider workers are disabled`,
      )
    }
    const isolatedModesEnabled = [
      crmBackgroundEnabled,
      intakeUploadVerificationEnabled,
      evaluationRunnerEnabled,
      venueMediaDerivativeEnabled,
    ].filter(Boolean).length
    if (isolatedModesEnabled > 1) {
      throw new Error('Provider-disabled isolated worker modes cannot be combined in one process')
    }
  }

  return providerEnabled
    ? {
        mode: 'provider-enabled',
        requiredEnvironmentKeys: [
          'REDIS_URL',
          'ANTHROPIC_API_KEY',
          'OPENAI_API_KEY',
          ...(intakeUploadVerificationEnabled
            ? [
                'DATABASE_URL',
                'DIRECT_DATABASE_URL',
                'STORAGE_BUCKET',
                'STORAGE_REGION',
                'STORAGE_ACCESS_KEY_ID',
                'STORAGE_SECRET_ACCESS_KEY',
                'INTAKE_CLAMAV_HOST',
              ]
            : []),
        ],
        intakeUploadVerificationEnabled,
      }
    : crmBackgroundEnabled
      ? {
          mode: 'crm-only',
          requiredEnvironmentKeys: [
            'REDIS_URL',
            'DATABASE_URL',
            'DIRECT_DATABASE_URL',
            ...(intakeUploadVerificationEnabled
              ? [
                  'STORAGE_BUCKET',
                  'STORAGE_REGION',
                  'STORAGE_ACCESS_KEY_ID',
                  'STORAGE_SECRET_ACCESS_KEY',
                  'INTAKE_CLAMAV_HOST',
                ]
              : []),
          ],
          intakeUploadVerificationEnabled,
        }
      : intakeUploadVerificationEnabled
        ? {
            mode: 'intake-upload-verification-only',
            requiredEnvironmentKeys: [
              'REDIS_URL',
              'DATABASE_URL',
              'DIRECT_DATABASE_URL',
              'STORAGE_BUCKET',
              'STORAGE_REGION',
              'STORAGE_ACCESS_KEY_ID',
              'STORAGE_SECRET_ACCESS_KEY',
              'INTAKE_CLAMAV_HOST',
            ],
            intakeUploadVerificationEnabled: true,
          }
        : evaluationRunnerEnabled
          ? {
              mode: 'evaluation-only',
              requiredEnvironmentKeys: [
                'REDIS_URL',
                'DATABASE_URL',
                'DIRECT_DATABASE_URL',
                'OPENAI_API_KEY',
              ],
              intakeUploadVerificationEnabled: false,
            }
          : venueMediaDerivativeEnabled
            ? {
                mode: 'venue-media-derivative-only',
                requiredEnvironmentKeys: [
                  'REDIS_URL',
                  'DATABASE_URL',
                  'DIRECT_DATABASE_URL',
                  'STORAGE_BUCKET',
                  'STORAGE_REGION',
                  'STORAGE_ACCESS_KEY_ID',
                  'STORAGE_SECRET_ACCESS_KEY',
                ],
                intakeUploadVerificationEnabled: false,
              }
            : founderAbsenceObserverEnabled
              ? {
                  mode: 'founder-absence-observer-only',
                  requiredEnvironmentKeys: ['REDIS_URL', 'DATABASE_URL', 'DIRECT_DATABASE_URL'],
                  intakeUploadVerificationEnabled: false,
                }
              : {
                  mode: 'provider-disabled',
                  requiredEnvironmentKeys: ['REDIS_URL'],
                  intakeUploadVerificationEnabled: false,
                }
}
