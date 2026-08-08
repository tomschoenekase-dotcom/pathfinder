export type DeploymentEnvironment = 'production' | 'staging' | 'preview'

export function environmentQueueName(environment: DeploymentEnvironment, baseName: string): string {
  // BullMQ reserves ':' for its Redis key format and rejects queue names that
  // contain it. Preserve the established production names while isolating
  // non-production queues with a BullMQ-safe delimiter.
  return environment === 'production' ? baseName : `${environment}--${baseName}`
}
