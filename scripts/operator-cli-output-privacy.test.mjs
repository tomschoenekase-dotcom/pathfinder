import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('staging migration spawn failures cannot serialize process exception text', async () => {
  const source = await readFile(new URL('./migrate-staging-db.mjs', import.meta.url), 'utf8')
  assert.match(source, /Staging migration process could not start: SPAWN_FAILED/u)
  assert.doesNotMatch(source, /child\.once\('error',\s*\(error\)/u)
  assert.doesNotMatch(source, /error\.message/u)
})

test('database seed failures cannot serialize Prisma exception details', async () => {
  const source = await readFile(new URL('../packages/db/prisma/seed.ts', import.meta.url), 'utf8')
  assert.match(source, /\.catch\(\(\) => \{/u)
  assert.match(source, /console\.error\('Seed failed\.'\)/u)
  assert.doesNotMatch(source, /console\.error\('Seed failed\.',\s*error\)/u)
})
