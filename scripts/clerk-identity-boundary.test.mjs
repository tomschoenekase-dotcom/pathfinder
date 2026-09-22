import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))
async function sources(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.next', '.turbo'].includes(entry.name)) continue
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sources(file)))
    else if (/\.[jt]sx?$/u.test(file) && !/\.(?:test|spec)\./u.test(file)) files.push(file)
  }
  return files
}

test('Clerk server identity imports stay at the reviewed provider boundary', async () => {
  const direct = []
  const clients = []
  for (const group of ['apps', 'packages']) {
    for (const file of await sources(path.join(root, group))) {
      const source = await readFile(file, 'utf8')
      const relative = path.relative(root, file).replaceAll(path.sep, '/')
      if (/from\s+['"]@clerk\/(?:nextjs\/server|backend)['"]/u.test(source)) direct.push(relative)
      if (/^['"]use client['"]/u.test(source.trimStart())) clients.push([relative, source])
    }
  }
  assert.deepEqual(direct.sort(), [
    'apps/dashboard/middleware.ts',
    'apps/web/middleware.ts',
    'packages/auth/src/auth.ts',
    'packages/auth/src/server.ts',
    'packages/auth/src/session.ts',
  ])
  for (const [file, source] of clients) {
    assert.doesNotMatch(
      source,
      /CLERK_IDENTITY_BINDING|@pathfinder\/auth(?:['"]|\/(?:server|identity-binding))/u,
      file,
    )
  }
  const binding = await readFile(path.join(root, 'packages/auth/src/identity-binding.ts'), 'utf8')
  assert.match(binding, /from 'node:crypto'/u) // A browser import must fail to bundle.
  const client = await readFile(path.join(root, 'packages/auth/src/client.ts'), 'utf8')
  assert.doesNotMatch(client, /identity-binding|\.\/server|CLERK_IDENTITY_BINDING/u)
})
