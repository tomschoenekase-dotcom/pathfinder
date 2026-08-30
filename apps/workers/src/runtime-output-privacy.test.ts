import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('worker runtime output privacy', () => {
  it('keeps direct runtime error writers code-only', async () => {
    for (const file of [
      'crm-background.ts',
      'founder-absence-observer-runtime.ts',
      'intake-upload-verification-runtime.ts',
    ]) {
      const source = await readFile(join(__dirname, file), 'utf8')
      expect(source).toContain('errorCode:')
      expect(source).not.toMatch(/detail:\s*error/u)
      expect(source).not.toMatch(/process\.stderr\.write\([\s\S]{0,400}error\.message/u)
    }
  })
})
