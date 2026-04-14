import IORedis from 'ioredis'

import { env } from '@pathfinder/config'

let sharedConnection: IORedis | null = null

export function getBullMQConnection(): IORedis {
  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL is not configured')
  }

  if (!sharedConnection) {
    sharedConnection = new IORedis(env.REDIS_URL, {
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
    })
  }

  return sharedConnection
}

export async function closeBullMQConnection(): Promise<void> {
  if (!sharedConnection) {
    return
  }

  const connection = sharedConnection
  sharedConnection = null
  await connection.quit()
}
