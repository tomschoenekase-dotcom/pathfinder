import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const migrationPath = fileURLToPath(
  new URL(
    '../../prisma/migrations/20260811170000_add_versioned_tone_presets/migration.sql',
    import.meta.url,
  ),
)
const sql = readFileSync(migrationPath, 'utf8')

describe('versioned tone preset migration contract', () => {
  it('is additive and retains the legacy ai_tone column', () => {
    expect(sql).toContain('ADD COLUMN "tone_preset" TEXT')
    expect(sql).toContain('ADD COLUMN "tone_preset_version" INTEGER')
    expect(sql).not.toMatch(/DROP COLUMN\s+"ai_tone"/u)
  })

  it('backfills only recognized legacy values and constrains client presets', () => {
    expect(sql).toContain("WHEN 'FRIENDLY' THEN 'friendly'")
    expect(sql).toContain("WHEN 'PROFESSIONAL' THEN 'informative'")
    expect(sql).toContain("WHEN 'PLAYFUL' THEN 'enthusiastic'")
    expect(sql).toContain("'friendly', 'concise', 'enthusiastic', 'informative'")
  })

  it('captures both versioned fields in forward venue history', () => {
    expect(sql).toContain("'tonePreset', OLD.tone_preset")
    expect(sql).toContain("'tonePresetVersion', OLD.tone_preset_version")
    expect(sql).toContain("'tonePreset', NEW.tone_preset")
    expect(sql).toContain("'tonePresetVersion', NEW.tone_preset_version")
    expect(sql).toContain('captured_reverted_from_id, 2')
  })
})
