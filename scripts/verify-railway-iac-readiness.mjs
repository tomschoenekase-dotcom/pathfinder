import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  auditRailwayIacReadiness,
  parseRailwayGraphJson,
  RailwayIacReadinessError,
} from './lib/railway-iac-readiness.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configs = {
  'staging-web': 'railway.staging.web.json',
  'staging-dashboard': 'railway.staging.dashboard.json',
  'staging-workers': 'railway.staging.workers.json',
}

try {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const graph = parseRailwayGraphJson(Buffer.concat(chunks).toString('utf8'))
  const configByService = Object.fromEntries(
    await Promise.all(
      Object.entries(configs).map(async ([service, path]) => [
        service,
        JSON.parse(await readFile(resolve(root, path), 'utf8')),
      ]),
    ),
  )
  const result = auditRailwayIacReadiness(graph, configByService)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (!result.migrationReady) process.exitCode = 2
} catch (error) {
  const code =
    error instanceof RailwayIacReadinessError
      ? error.code
      : 'unexpected-railway-iac-readiness-failure'
  process.stderr.write(`Railway IaC readiness verification failed: ${code}\n`)
  process.exitCode = 1
}
