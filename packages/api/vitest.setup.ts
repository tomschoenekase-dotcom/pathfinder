const syntheticTestEnvironment = {
  DATABASE_URL: 'postgresql://pathfinder_test:pathfinder_test@127.0.0.1:5432/pathfinder_test',
  DIRECT_DATABASE_URL:
    'postgresql://pathfinder_test:pathfinder_test@127.0.0.1:5432/pathfinder_test',
  CLERK_SECRET_KEY: 'sk_test_pathfinder_unit_tests',
  CLERK_PUBLISHABLE_KEY: 'pk_test_pathfinder_unit_tests',
} as const

const remoteOnboardingDisposableProof = process.env.RUN_REMOTE_ONBOARDING_E2E_DB_INTEGRATION === '1'

for (const [name, value] of Object.entries(syntheticTestEnvironment)) {
  if (
    remoteOnboardingDisposableProof &&
    (name === 'DATABASE_URL' || name === 'DIRECT_DATABASE_URL')
  )
    continue
  process.env[name] = value
}
