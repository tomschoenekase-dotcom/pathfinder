import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('PWA operator contract', () => {
  it('documents bounded offline behavior and forward retirement', () => {
    const guide = readFileSync(
      resolve(process.cwd(), '../../docs/pwa-offline-lifecycle.md'),
      'utf8',
    )
    const environmentExample = readFileSync(resolve(process.cwd(), '../../.env.example'), 'utf8')

    expect(environmentExample).toContain('NEXT_PUBLIC_PWA_ENABLED=true')
    expect(guide).toContain('does not cache venue pages, chat messages, API responses')
    expect(guide).toContain('NEXT_PUBLIC_PWA_ENABLED=false')
    expect(guide).toContain('pathfinder-offline-')
    expect(guide).toContain('A Git revert alone does not unregister')
  })
})
