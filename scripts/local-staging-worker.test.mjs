import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const script = await readFile(new URL('./local-staging.ps1', import.meta.url), 'utf8')
const compose = await readFile(new URL('../compose.local-staging.yml', import.meta.url), 'utf8')

test('local staging owns an observable provider-disabled worker lifecycle', () => {
  assert.match(script, /\$workerPidFile = Join-Path \$stateRoot 'workers\.pid'/u)
  assert.match(script, /Start-WorkerProcess \$workerPidFile/u)
  assert.match(script, /Wait-ForWorker \$workerPid/u)
  assert.match(script, /Stop-RecordedProcess \$workerPidFile 'dist\/bootstrap\.js'/u)
  assert.match(script, /workerPid = \$workerPid/u)
  assert.match(script, /workerMode = 'provider-disabled-health-only'/u)
})

test('local staging keeps every provider-executing worker path dark', () => {
  for (const flag of [
    'OUTBOUND_PROVIDER_WORKERS_ENABLED',
    'INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED',
    'WORKER_SCHEDULERS_ENABLED',
    'EMBEDDING_DISPATCH_ENABLED',
    'GENERATION_DISPATCH_ENABLED',
    'GENERATION_RECOVERY_ENABLED',
    'EVALUATION_RUNNER_ENABLED',
  ]) {
    assert.match(script, new RegExp(`\\$env:${flag} = 'false'`, 'u'))
  }
})

test('phone uploads use the active LAN address while privileged dependencies stay loopback-only', () => {
  assert.match(script, /IPv4DefaultGateway -ne \$null/u)
  assert.match(script, /\$env:STORAGE_ENDPOINT = "http:\/\/\$\{localStagingLanAddress\}:59000"/u)
  assert.match(script, /PATHFINDER_LOCAL_STAGING_DASHBOARD_ORIGIN/u)
  assert.match(
    compose,
    /\$\{PATHFINDER_LOCAL_STAGING_MINIO_BIND_ADDRESS:-127\.0\.0\.1\}:59000:9000/u,
  )
  assert.match(compose, /\$\{PATHFINDER_LOCAL_STAGING_DASHBOARD_ORIGIN/u)
  for (const mapping of ['55440:5432', '56380:6379', '59001:9001', '53310:3310']) {
    assert.match(compose, new RegExp(`127\\.0\\.0\\.1:${mapping}`, 'u'))
  }
})

test('every local staging dependency is content-addressed', () => {
  const imageLines = [...compose.matchAll(/^\s+image:\s+([^\s]+)\s*$/gmu)].map((match) => match[1])
  assert.deepEqual(imageLines.length, 5)
  for (const image of imageLines) {
    assert.match(
      image,
      /^[a-z0-9./_-]+(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/u,
      `Unpinned local-staging image: ${image}`,
    )
  }
  assert.doesNotMatch(compose, /^\s+image:\s+[^\s@]+\s*$/gmu)
})
