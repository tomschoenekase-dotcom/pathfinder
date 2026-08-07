export type DeploymentEnvironment = 'production' | 'staging' | 'preview'

export function environmentQueueName(environment: DeploymentEnvironment, baseName: string): string {
  return environment === 'production' ? baseName : `${environment}:${baseName}`
}
