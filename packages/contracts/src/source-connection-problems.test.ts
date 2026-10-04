import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { describeSourceConnectionProblem } from './source-connection-problems'

const repository = fileURLToPath(new URL('../../../', import.meta.url))

function emittedCodes(): string[] {
  const read = (path: string) => readFileSync(`${repository}${path}`, 'utf8')
  const fetch = read('apps/workers/src/lib/source-connection-fetch.ts')
  const extract = read('apps/workers/src/lib/source-connection-extract.ts')
  const poll = read('apps/workers/src/processors/source-connection-poll.ts')
  return [
    ...[...fetch.matchAll(/FetchError\('([a-z_]+)'/gu)].map((match) => match[1]!),
    ...[...fetch.matchAll(/errorCategory: '([a-z_]+)'/gu)].map((match) => match[1]!),
    ...[...extract.matchAll(/refuse\('([A-Z_]+)'\)/gu)].map((match) => match[1]!),
    ...[...poll.matchAll(/(?:errorCategory|recordEarlyFailure)\(?:? ?'([a-z_]+)'/gu)].map(
      (match) => match[1]!,
    ),
  ]
}

describe('source connection problem catalog', () => {
  it('gives every code the pipeline emits a plain-language meaning', () => {
    const codes = emittedCodes()
    expect(codes.length).toBeGreaterThan(40)
    for (const code of codes)
      expect(describeSourceConnectionProblem(code), code).not.toMatch(/^Something went wrong/u)
  })
  it('is case-insensitive and labels unknown codes without inventing a meaning', () => {
    expect(describeSourceConnectionProblem('DATE_INVALID')).toBe(
      describeSourceConnectionProblem('date_invalid'),
    )
    expect(describeSourceConnectionProblem('mystery_code')).toBe(
      'Something went wrong reading the source (code mystery_code).',
    )
  })
})
