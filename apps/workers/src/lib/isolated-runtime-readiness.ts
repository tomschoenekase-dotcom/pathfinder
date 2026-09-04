import { resolveReleaseRevision } from '@pathfinder/config/release-identity'

import { startOperationalHeartbeat } from './operational-heartbeat'
import {
  recordOperationalReadinessHeartbeat,
  resolveServiceDependencyProbeEnvironment,
} from './service-dependency-readiness'

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>

export async function startIsolatedRuntimeReadinessHeartbeat(
  input: {
    schedulersEnabled: boolean
    environment?: RuntimeEnvironment
  },
  dependencies: {
    startHeartbeat?: typeof startOperationalHeartbeat
    recordHeartbeat?: typeof recordOperationalReadinessHeartbeat
    onError?: (error: unknown) => void
  } = {},
) {
  const environment = input.environment ?? process.env
  return (dependencies.startHeartbeat ?? startOperationalHeartbeat)({
    write: () =>
      (dependencies.recordHeartbeat ?? recordOperationalReadinessHeartbeat)({
        mode: 'provider-disabled',
        schedulersEnabled: input.schedulersEnabled,
        revision: resolveReleaseRevision(environment),
        environment: resolveServiceDependencyProbeEnvironment(environment),
      }),
    onError:
      dependencies.onError ??
      (() =>
        process.stderr.write(
          `${JSON.stringify({
            action: 'workers.heartbeat.failed',
            errorCode: 'operational-readiness-heartbeat-failed',
          })}\n`,
        )),
  })
}
