export type DeploymentEnvironment = 'production' | 'staging' | 'preview'

export function resolveDeploymentEnvironment(
  value: string | undefined,
  nodeEnvironment: string | undefined,
): DeploymentEnvironment {
  if (value === 'production' || value === 'staging' || value === 'preview') {
    return value
  }

  if (nodeEnvironment === 'production') {
    throw new Error('RAILWAY_ENVIRONMENT must identify production, staging, or preview.')
  }

  return 'staging'
}

export function deploymentStorageKey(environment: DeploymentEnvironment, key: string): string {
  return environment === 'production' ? key : `${environment}/${key}`
}

export function currentDeploymentStorageKey(key: string): string {
  return deploymentStorageKey(
    resolveDeploymentEnvironment(process.env.RAILWAY_ENVIRONMENT, process.env.NODE_ENV),
    key,
  )
}
