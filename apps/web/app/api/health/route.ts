import { db } from '@pathfinder/db'
import { getBullMQConnection } from '@pathfinder/jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_DEPENDENCY_TIMEOUT_MS = 2_000
const DEPENDENCY_TIMEOUT = Symbol('dependency-timeout')

type DependencyStatus = 'up' | 'down' | 'timeout'

interface DeploymentIdentity {
  environment: string
  revision: string
}

interface HealthDependencies {
  checkDatabase: () => Promise<unknown>
  checkQueue: () => Promise<unknown>
  deployment: DeploymentIdentity
  timeoutMs?: number
}

function deploymentIdentity(): DeploymentIdentity {
  return {
    environment:
      process.env.RAILWAY_ENVIRONMENT ??
      process.env.VERCEL_ENV ??
      process.env.NODE_ENV ??
      'unknown',
    revision: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? 'unknown',
  }
}

async function dependencyStatus(
  check: () => Promise<unknown>,
  timeoutMs: number,
): Promise<DependencyStatus> {
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    await Promise.race([
      Promise.resolve().then(check),
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
  deployment,
  timeoutMs = DEFAULT_DEPENDENCY_TIMEOUT_MS,
}: HealthDependencies): () => Promise<Response> {
  return async () => {
    const [dbStatus, queueStatus] = await Promise.all([
      dependencyStatus(checkDatabase, timeoutMs),
      dependencyStatus(checkQueue, timeoutMs),
    ])

    const body = {
      ok: dbStatus === 'up' && queueStatus === 'up',
      deployment,
      deps: {
        db: dbStatus,
        queue: queueStatus,
      },
    }

    return Response.json(body, { status: body.ok ? 200 : 503 })
  }
}

export const GET = createHealthHandler({
  checkDatabase: () => {
    // Deliberate system-level raw SQL probe: SELECT 1 reads no tenant table or
    // tenant data, so a tenant_id bind is neither available nor required.
    return db.$queryRaw`SELECT 1`
  },
  checkQueue: () => getBullMQConnection().ping(),
  deployment: deploymentIdentity(),
})
