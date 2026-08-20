import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')

test('the staging web image admits its public origin before the Next.js build', async () => {
  const dockerfile = await readFile(path.join(root, 'Dockerfile.web.staging'), 'utf8')
  const builderStart = dockerfile.indexOf('FROM base AS builder')
  const runnerStart = dockerfile.indexOf('FROM base AS runner')

  assert.notEqual(builderStart, -1)
  assert.ok(runnerStart > builderStart)

  const builderStage = dockerfile.slice(builderStart, runnerStart)
  const publicOriginArg = builderStage.indexOf('ARG NEXT_PUBLIC_WEB_URL')
  const webBuild = builderStage.indexOf('RUN pnpm --filter @pathfinder/web build')

  assert.notEqual(publicOriginArg, -1)
  assert.ok(webBuild > publicOriginArg)
})
