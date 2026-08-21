import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, 'crm-background.ts'), 'utf8')

describe('provider-free CRM background registration', () => {
  it('registers durable stale-summary refresh beside CRM imports', () => {
    expect(source).toContain('ACCOUNT_SUMMARY_REFRESH_QUEUE')
    expect(source).toContain('ACCOUNT_SUMMARY_REFRESH_SCHEDULER_JOB')
    expect(source).toContain('processStaleAccountSummaries')
    expect(source).toContain('{ every: 5 * 60_000 }')
  })
})
