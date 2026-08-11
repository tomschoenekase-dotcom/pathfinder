import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RETENTION_DATA_INVENTORY, RetentionDecisionKey } from '@pathfinder/contracts'
import { describe, expect, it } from 'vitest'

const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8')

describe('retention data inventory contract', () => {
  it('maps only concrete Prisma models', () => {
    for (const entry of RETENTION_DATA_INVENTORY) {
      expect(schema, `${entry.model} is missing from Prisma schema`).toMatch(
        new RegExp(`^model\\s+${entry.model}\\s+\\{`, 'm'),
      )
    }
  })

  it('has at least one inventory entry for every owner policy decision', () => {
    const covered = new Set(RETENTION_DATA_INVENTORY.map((entry) => entry.decisionKey))
    for (const decisionKey of RetentionDecisionKey.options) {
      expect(covered, `${decisionKey} has no data inventory mapping`).toContain(decisionKey)
    }
  })

  it('does not duplicate model mappings or imply an executable policy', () => {
    const models = RETENTION_DATA_INVENTORY.map((entry) => entry.model)
    expect(new Set(models).size).toBe(models.length)
    expect(RETENTION_DATA_INVENTORY.every((entry) => entry.notes.trim().length > 0)).toBe(true)
  })
})
