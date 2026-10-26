import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export const RELEASE269_STAGING_REDIS = Object.freeze({
  project: '8621111a-4ac8-4d88-9566-4627c8a02059',
  environment: 'a7a394fc-aa4e-4a45-bd3c-904419a67818',
  service: '9fec9bdb-1915-4bee-8213-f6c3d434baa1',
  resource: 'd53ab235-d403-4d7d-b525-3ace0ef07b92',
  host: 'redis-5vrb.railway.internal',
})

// Frozen release inventory; a test compares this to the complete source registry.
export const RELEASE269_QUEUE_BASE_NAMES = Object.freeze([
  'weekly-digest',
  'answer-analysis',
  'weekly-report',
  'generation-recovery',
  'generation-dispatch',
  'daily-rollup',
  'embed-place',
  'embed-knowledge-entry',
  'embedding-dispatch',
  'analytics-enrichment',
  'send-email',
  'operational-event-delivery',
  'media-ingestion',
  'evaluation-run',
  'guest-answer-attribution-evaluation',
  'agent-run',
  'agent-question-maintenance',
  'agent-routine-maintenance',
  'prospect-import',
  'gmail-sync',
  'billing-reconciliation',
  'account-summary-refresh',
  'voice-session-recovery',
  'intake-upload-verification',
  'intake-v1-source-processing',
  'intake-v1-file-extraction',
  'venue-media-derivative',
  'live-data-poll',
])

// Same atomic read-only operations as the historical private release queue tool.
// No queue objects, schedulers, getters that repair markers, or deletion commands.
export const RELEASE269_QUEUE_COUNTS_LUA = `local out = {}; for _, name in ipairs(ARGV) do
 local p = 'bull:' .. name .. ':'
 out[name] = {waiting=redis.call('LLEN',p..'wait')+redis.call('LLEN',p..'paused'),
 active=redis.call('LLEN',p..'active'), delayed=redis.call('ZCARD',p..'delayed'),
 prioritized=redis.call('ZCARD',p..'prioritized'), waitingChildren=redis.call('ZCARD',p..'waiting-children'),
 failed=redis.call('ZCARD',p..'failed')}
end; return cjson.encode(out)`

export function assertRelease269StagingRedis(environment) {
  const expected = RELEASE269_STAGING_REDIS
  assert.equal(environment.RAILWAY_PROJECT_ID, expected.project, 'release269-redis-project-refused')
  assert.equal(
    environment.RAILWAY_ENVIRONMENT_ID,
    expected.environment,
    'release269-redis-environment-refused',
  )
  assert.equal(environment.RAILWAY_ENVIRONMENT, 'staging', 'release269-redis-environment-refused')
  assert.equal(environment.RAILWAY_SERVICE_ID, expected.service, 'release269-redis-service-refused')
  assert.equal(
    environment.REDIS_RESOURCE_ID,
    expected.resource,
    'release269-redis-resource-refused',
  )
  if (environment.RELEASE269_QUEUE_RESOURCE_ID)
    assert.equal(
      environment.RELEASE269_QUEUE_RESOURCE_ID,
      expected.resource,
      'release269-redis-resource-refused',
    )
  let url
  try {
    url = new URL(environment.REDIS_URL)
  } catch {
    throw new Error('release269-redis-url-refused')
  }
  assert.ok(
    url.protocol === 'redis:' &&
      url.hostname === expected.host &&
      (url.port || '6379') === '6379' &&
      ['', '/', '/0'].includes(url.pathname) &&
      !url.search &&
      !url.hash,
    'release269-redis-target-refused',
  )
  return expected.resource
}

export async function readRelease269StagingQueues({
  environment,
  releaseSha,
  createConnection,
  now = Date.now,
  preserveDormantQueues = false,
}) {
  assert.match(releaseSha ?? '', /^[a-f0-9]{40}$/u, 'release269-queue-release-required')
  const resourceIdentity = assertRelease269StagingRedis(environment)
  const names = RELEASE269_QUEUE_BASE_NAMES.map((name) => `staging--${name}`)
  let connection
  const startedAt = now()
  try {
    connection = createConnection(environment.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      enableReadyCheck: false,
      connectTimeout: 5000,
      commandTimeout: 10000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    })
    connection.on('error', () => {})
    await connection.connect()
    if (preserveDormantQueues) {
      const { readPreservedQueues } = await import('./release269-queue-preservation.mjs')
      return await readPreservedQueues({
        connection,
        target: 'staging',
        releaseSha,
        resourceIdentity,
        now,
      })
    }
    const raw = await connection.call('EVAL_RO', RELEASE269_QUEUE_COUNTS_LUA, '0', ...names)
    assert.ok(
      typeof raw === 'string' && Buffer.byteLength(raw) <= 131072,
      'release269-queue-response-refused',
    )
    const counts = JSON.parse(raw)
    assert.ok(
      counts && typeof counts === 'object' && !Array.isArray(counts),
      'release269-queue-response-refused',
    )
    assert.deepEqual(
      Object.keys(counts).sort(),
      [...names].sort(),
      'release269-queue-coverage-refused',
    )
    for (const value of Object.values(counts)) {
      assert.deepEqual(
        Object.keys(value).sort(),
        ['waiting', 'active', 'delayed', 'prioritized', 'waitingChildren', 'failed'].sort(),
        'release269-queue-counts-refused',
      )
      for (const key of [
        'waiting',
        'active',
        'delayed',
        'prioritized',
        'waitingChildren',
        'failed',
      ]) {
        assert.ok(
          Number.isSafeInteger(value[key]) && value[key] >= 0,
          'release269-queue-counts-refused',
        )
        if (key !== 'failed') assert.equal(value[key], 0, 'release269-queue-not-drained')
      }
    }
    const endedAt = now()
    assert.ok(endedAt >= startedAt && endedAt - startedAt <= 15000, 'release269-queue-read-timeout')
    return {
      schema: 'torchiko-release269-queue-drain/v1',
      target: 'staging',
      releaseSha,
      coverage: 'all-application-queues',
      resourceIdentity,
      observedAt: new Date(endedAt).toISOString(),
      waiting: 0,
      active: 0,
      delayed: 0,
      prioritized: 0,
      waitingChildren: 0,
      registry: names,
      countsSha256: createHash('sha256').update(raw).digest('hex'),
      transport: 'pinned-staging-redis-EVAL_RO',
    }
  } catch {
    // Drivers may attach credentials to diagnostics. Never propagate their errors.
    throw new Error('release269-live-queue-read-refused')
  } finally {
    try {
      connection?.disconnect()
    } catch {
      throw new Error('release269-queue-disconnect-failed')
    }
  }
}
