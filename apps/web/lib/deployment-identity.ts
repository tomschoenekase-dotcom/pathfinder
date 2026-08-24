import { resolveReleaseRevision } from '@pathfinder/config/release-identity'

export interface DeploymentIdentity {
  environment: string
  revision: string
  resources: {
    database: string
    redis: string
    storage: string
  }
}

export function deploymentIdentity(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DeploymentIdentity {
  return {
    environment:
      environment.RAILWAY_ENVIRONMENT ??
      environment.VERCEL_ENV ??
      environment.NODE_ENV ??
      'unknown',
    revision: resolveReleaseRevision(environment),
    resources: {
      database: environment.DATABASE_RESOURCE_ID ?? 'unknown',
      redis: environment.REDIS_RESOURCE_ID ?? 'unknown',
      storage: environment.STORAGE_RESOURCE_ID ?? 'disabled',
    },
  }
}
