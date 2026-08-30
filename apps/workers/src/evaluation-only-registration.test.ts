import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('evaluation-only worker registration', () => {
  it('registers only evaluation consumers and reports the isolated mode', () => {
    const source = readFileSync(resolve(__dirname, 'evaluation-only-runtime.ts'), 'utf8')

    const workerQueues = [...source.matchAll(/new Worker\(\s*([A-Z_]+_QUEUE)/gu)].map(
      (match) => match[1],
    )
    expect(workerQueues).toEqual([
      'EVALUATION_RUN_QUEUE',
      'GUEST_ANSWER_ATTRIBUTION_EVALUATION_QUEUE',
    ])
    expect(source).toContain("mode: 'evaluation-only'")
    expect(source).toContain('outboundProviderWorkersEnabled: false')
  })
})
