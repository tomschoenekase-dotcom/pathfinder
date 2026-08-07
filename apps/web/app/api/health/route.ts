import { db } from '@pathfinder/db'
import { getBullMQConnection } from '@pathfinder/jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type DependencyStatus = 'up' | 'down'

async function dependencyStatus(check: () => Promise<unknown>): Promise<DependencyStatus> {
  try {
    await check()
    return 'up'
  } catch {
    return 'down'
  }
}

export async function GET() {
  const [dbStatus, queueStatus] = await Promise.all([
    dependencyStatus(() => db.$queryRaw`SELECT 1`),
    dependencyStatus(() => getBullMQConnection().ping()),
  ])

  const body = {
    ok: dbStatus === 'up' && queueStatus === 'up',
    deps: {
      db: dbStatus,
      queue: queueStatus,
    },
  }

  return Response.json(body, { status: body.ok ? 200 : 503 })
}
