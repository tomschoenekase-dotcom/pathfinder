import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DockerContextBoundaryError,
  verifyDockerContextBoundary,
  verifyDockerIgnoreInventory,
  verifyDockerfileContextGuard,
} from './lib/docker-context-boundary.mjs'

const validRules = `
**/.env
**/.env.*
**/*.env
**/*.env.*
**/.claude/
`

test('accepts the complete protected-path boundary', () => {
  assert.deepEqual(verifyDockerContextBoundary(validRules), { protectedRuleCount: 5 })
})

test('rejects a missing nested environment rule without naming local files', () => {
  assert.throws(
    () => verifyDockerContextBoundary(validRules.replace('**/.env.*\n', '')),
    (error) =>
      error instanceof DockerContextBoundaryError &&
      error.message === 'Docker context boundary is missing 1 required protected-path rule(s).',
  )
})

test('rejects an environment re-inclusion rule', () => {
  assert.throws(
    () => verifyDockerContextBoundary(`${validRules}!packages/example/.env\n`),
    /must not use re-inclusion rules/u,
  )
})

test('rejects a local-agent re-inclusion rule', () => {
  assert.throws(
    () => verifyDockerContextBoundary(`${validRules}!tools/.claude/settings.local.json\n`),
    /must not use re-inclusion rules/u,
  )
})

test('rejects a broad re-inclusion that could override a protected path', () => {
  assert.throws(
    () => verifyDockerContextBoundary(`${validRules}!packages/**\n`),
    /must not use re-inclusion rules/u,
  )
})

const guardedDockerfile = `
FROM node:20-alpine AS installer
COPY . .
RUN ! find . -type f \\( -name '.env' -o -name '.env.*' \\) -print -quit | grep -q . \\
  && ! find . -type d -name '.claude' -print -quit | grep -q .
RUN pnpm install --frozen-lockfile
`

test('accepts a protected-path image guard before dependency installation', () => {
  assert.deepEqual(verifyDockerfileContextGuard(guardedDockerfile), {
    guardedBeforeInstall: true,
  })
})

test('rejects a protected-path image guard after dependency installation', () => {
  const lateGuard = guardedDockerfile.replace(
    /COPY \. \.\n(?<guard>RUN ! find[\s\S]+?grep -q \.\n)RUN pnpm install --frozen-lockfile/u,
    'COPY . .\nRUN pnpm install --frozen-lockfile\n$<guard>',
  )
  assert.throws(
    () => verifyDockerfileContextGuard(lateGuard),
    /must verify protected paths immediately after source copy and before install/u,
  )
})

test('accepts only the root Docker ignore policy', () => {
  assert.deepEqual(verifyDockerIgnoreInventory(['.dockerignore']), { ignoreFileCount: 1 })
})

test('rejects a Dockerfile-specific ignore override', () => {
  assert.throws(
    () => verifyDockerIgnoreInventory(['.dockerignore', 'Dockerfile.workers.dockerignore']),
    /forbids alternate ignore files/u,
  )
})

test('rejects a nested Docker ignore override', () => {
  assert.throws(
    () => verifyDockerIgnoreInventory(['.dockerignore', 'apps/web/.dockerignore']),
    /forbids alternate ignore files/u,
  )
})
