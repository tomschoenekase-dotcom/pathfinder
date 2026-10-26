import { describe, expect, it } from 'vitest'
import { z } from 'zod'

describe('bounded schema parsing security', () => {
  it('rejects oversized arrays before validating their elements', () => {
    let visited = 0
    const element = z.string().refine(() => {
      visited++
      return true
    })
    const bounded = [z.array(element).max(2), z.array(element).length(2)]
    for (const schema of [...bounded, ...bounded.map((item) => z.compile(item))]) {
      const result = schema.safeParse(Array(10000).fill('item'))
      expect(result.success).toBe(false)
      if (!result.success) expect(result.error.issues).toHaveLength(1)
    }
    expect(visited).toBe(0)
  })

  it('preserves UTF-16 field limits in runtime and compiled parsers', () => {
    const astral = '\u{1F600}'
    const schemas = [z.string().max(5000), z.string().min(2), z.string().length(2)]
    for (const compile of [false, true]) {
      const [max, min, exact] = schemas.map((schema) =>
        compile ? z.compile(schema, { strict: true }) : schema,
      )
      expect(max!.safeParse('x'.repeat(4998) + astral).success).toBe(true)
      expect(max!.safeParse('x'.repeat(4999) + astral).success).toBe(false)
      expect(min!.safeParse(astral).success).toBe(true)
      expect(min!.safeParse('x').success).toBe(false)
      expect(exact!.safeParse(astral).success).toBe(true)
      expect(exact!.safeParse(astral + 'x').success).toBe(false)
    }
  })
})
