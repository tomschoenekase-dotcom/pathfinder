import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const guardedFiles = [
  'apps/workers/src/processors/gmail-sync.ts',
  'apps/workers/src/processors/prospect-import.ts',
  'apps/dashboard/app/api/integrations/gmail/oauth/callback/route.ts',
]

test('durable CRM failure records cannot copy arbitrary exception messages', async () => {
  const root = new URL('../', import.meta.url)
  for (const relativePath of guardedFiles) {
    const source = await readFile(new URL(relativePath, root), 'utf8')
    assert.doesNotMatch(source, /summary:[^\n]*error\.message/u)
    assert.doesNotMatch(source, /processingError:[^\n]*error\.message/u)
    assert.doesNotMatch(source, /reconciliation:[^\n]*error\.message/u)
  }
})
