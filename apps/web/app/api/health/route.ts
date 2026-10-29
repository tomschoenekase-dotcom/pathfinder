import { checkDatabaseConnection } from '@pathfinder/db'
import { checkBullMQConnection, readGenerationHealth, type GenerationHealth } from '@pathfinder/jobs'

import { deploymentIdentity, type DeploymentIdentity } from '../../../lib/deployment-identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_DEPENDENCY_TIMEOUT_MS = 2_000
const DEPENDENCY_TIMEOUT = Symbol('dependency-timeout')

type DependencyStatus = 'up' | 'down' | 'timeout'

interface HealthDependencies {
  checkDatabase: (timeoutMs: number) => Promise<unknown>
  checkQueue: (timeoutMs: number) => Promise<unknown>
  readGeneration: () => Promise<GenerationHealth>
  deployment: DeploymentIdentity
  timeoutMs?: number
}

async function generationStatus(read: () => Promise<GenerationHealth>): Promise<GenerationHealth> {
  const unknown: GenerationHealth = { status: 'unknown', lastFailureCode: null, since: null }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<GenerationHealth>((resolve) => {
        timer = setTimeout(() => resolve(unknown), 250)
        timer.unref?.()
      }),
    ])
  } catch { return unknown } finally { if (timer) clearTimeout(timer) }
}

async function dependencyStatus(
  check: (timeoutMs: number) => Promise<unknown>,
  timeoutMs: number,
): Promise<DependencyStatus> {
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    await Promise.race([
      Promise.resolve().then(() => check(timeoutMs)),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(DEPENDENCY_TIMEOUT), timeoutMs)
        timeout.unref?.()
      }),
    ])
    return 'up'
  } catch (error) {
    if (error === DEPENDENCY_TIMEOUT) {
      return 'timeout'
    }

    return 'down'
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

function createHealthHandler({
  checkDatabase,
  checkQueue,
  readGeneration,
  deployment,
  timeoutMs = DEFAULT_DEPENDENCY_TIMEOUT_MS,
}: HealthDependencies): () => Promise<Response> {
  return async () => {
    const [dbStatus, queueStatus, generation] = await Promise.all([
      dependencyStatus(checkDatabase, timeoutMs),
      dependencyStatus(checkQueue, timeoutMs),
      generationStatus(readGeneration),
    ])

    const body = {
      ok: dbStatus === 'up' && queueStatus === 'up',
      deployment,
      generation,
      deps: {
        db: dbStatus,
        queue: queueStatus,
      },
    }

    return Response.json(body, {
      status: body.ok ? 200 : 503,
      headers: { 'cache-control': 'no-store' },
    })
  }
}

export const GET = createHealthHandler({
  checkDatabase: checkDatabaseConnection,
  checkQueue: checkBullMQConnection,
  readGeneration: readGenerationHealth,
  deployment: deploymentIdentity(),
})
