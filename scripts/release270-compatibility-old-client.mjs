import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { validateDisposableDatabaseUrl } from './lib/disposable-prisma-migration.mjs'
import { DATABASE } from './lib/release270-compatibility.mjs'

assert.equal(process.env.RELEASE270_COMPATIBILITY_CONFIRM, DATABASE)
validateDisposableDatabaseUrl(process.env.DATABASE_URL, DATABASE)
assert.equal(process.env.DIRECT_DATABASE_URL, process.env.DATABASE_URL)
const root = resolve(process.argv[2])
const require = createRequire(resolve(root, 'packages/db/package.json'))
const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()
try {
  const entries = await db.venueKnowledgeEntry.findMany({
    where: { tenantId: 'fictional-release270-compatibility', category: 'EVENT' },
  })
  assert.equal(entries.length, 2)
  for (const entry of entries) assert.match(entry.content, /Starts: 2026-11-01T18:30:00\.123Z/)
  const scope = { tenantId: 'fictional-release270-compatibility', venueId: 'compat-venue' }
  await db.contentModuleIdentity.create({
    data: { id: 'compat-old-write', ...scope, kind: 'OPERATIONAL_FACT' },
  })
  await db.contentModuleRevision.create({
    data: {
      id: 'compat-old-write-revision',
      ...scope,
      moduleId: 'compat-old-write',
      kind: 'OPERATIONAL_FACT',
      version: 1,
      audience: 'PUBLIC',
      createdBy: 'fictional-old-client',
    },
  })
  await db.operationalFactContent.create({
    data: {
      revisionId: 'compat-old-write-revision',
      ...scope,
      label: 'Fictional old-client write',
      value: 'Entry is through the east door.',
    },
  })
  const fact = await db.operationalFactContent.findUniqueOrThrow({
    where: { revisionId: 'compat-old-write-revision' },
  })
  assert.equal(fact.value, 'Entry is through the east door.')
  console.log('Historical generated client read migrated projections and wrote/read a fact.')
} finally {
  await db.$disconnect()
}
