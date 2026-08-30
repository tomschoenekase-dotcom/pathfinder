import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function productionTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'dev-fixtures') return []
      return productionTsxFiles(path)
    }
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [path] : []
  })
}

describe('dashboard data table accessibility', () => {
  const files = [...productionTsxFiles('app'), ...productionTsxFiles('components')]
  const tables = files.flatMap((file) => {
    const source = readFileSync(file, 'utf8')
    return [...source.matchAll(/<table\b[\s\S]*?<\/table>/g)].map((match, index) => ({
      file,
      index,
      source: match[0],
    }))
  })

  it('gives every production table an accessible caption', () => {
    expect(tables.length).toBeGreaterThan(0)
    for (const table of tables) {
      expect(table.source, `${table.file} table ${table.index + 1}`).toMatch(/<caption\b/)
    }
  })

  it('declares an explicit row or column scope on every header cell', () => {
    for (const table of tables) {
      const headers = [...table.source.matchAll(/<th(?=\s|>)[^>]*>/g)].map((match) => match[0])
      for (const header of headers) {
        expect(header, `${table.file} table ${table.index + 1}`).toMatch(/scope=(?:"|{)[^"}]+/)
      }
    }
  })
})
