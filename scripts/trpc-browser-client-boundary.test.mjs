import assert from 'node:assert/strict'
import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function collectProductionSources(relativeDirectory) {
  const absoluteDirectory = path.join(repositoryRoot, relativeDirectory)
  const entries = await readdir(absoluteDirectory, { withFileTypes: true })
  const sources = []

  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name)
    if (entry.isDirectory()) {
      sources.push(...(await collectProductionSources(relativePath)))
    } else if (/\.(?:ts|tsx)$/u.test(entry.name) && !/\.test\.(?:ts|tsx)$/u.test(entry.name)) {
      sources.push(relativePath)
    }
  }

  return sources
}

test('browser tRPC clients are provider-owned and reset at authorization scopes', async () => {
  const boundaries = [
    {
      provider: 'apps/dashboard/lib/trpc.tsx',
      removedFactory: 'apps/dashboard/lib/trpc.ts',
      layouts: [
        ['apps/dashboard/app/(app)/layout.tsx', 'scopeKey={`tenant:${effectiveOrgId}`}'],
        ['apps/dashboard/app/(admin)/layout.tsx', 'scopeKey={`admin:${userId}`}'],
      ],
    },
    {
      provider: 'apps/web/lib/trpc.tsx',
      removedFactory: 'apps/web/lib/trpc.ts',
      layouts: [['apps/web/app/[venueSlug]/chat/layout.tsx', 'scopeKey={`venue:${venueSlug}`}']],
    },
  ]

  for (const boundary of boundaries) {
    const providerSource = await readFile(path.join(repositoryRoot, boundary.provider), 'utf8')
    assert.match(providerSource, /export function TRPCProvider/u)
    assert.match(providerSource, /export function useTRPCClient/u)
    assert.doesNotMatch(providerSource, /export function createTRPCClient/u)
    await assert.rejects(access(path.join(repositoryRoot, boundary.removedFactory)), {
      code: 'ENOENT',
    })

    for (const [layout, scopeKey] of boundary.layouts) {
      const source = await readFile(path.join(repositoryRoot, layout), 'utf8')
      assert.match(source, /<TRPCProvider/u, `${layout} must mount the browser client provider`)
      assert.ok(
        source.includes(scopeKey),
        `${layout} must key the provider to its authorization scope`,
      )
    }
  }

  const consumerRoots = [
    'apps/dashboard/app',
    'apps/dashboard/components',
    'apps/web/app',
    'apps/web/components',
    'apps/web/hooks',
  ]
  const productionSources = (await Promise.all(consumerRoots.map(collectProductionSources))).flat()

  for (const relativePath of productionSources) {
    const source = await readFile(path.join(repositoryRoot, relativePath), 'utf8')
    assert.doesNotMatch(
      source,
      /\bcreateTRPCClient\b/u,
      `${relativePath} must consume the route-scoped client instead of constructing one`,
    )
    assert.doesNotMatch(
      source,
      /\.createClient\s*\(/u,
      `${relativePath} must not bypass the route-scoped provider through the tRPC factory`,
    )
  }
})
