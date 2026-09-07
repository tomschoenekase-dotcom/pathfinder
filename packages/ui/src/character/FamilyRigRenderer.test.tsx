import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { CHARACTER_STATES } from '@pathfinder/contracts/character-system'

import { resolveFamilyRigMotion } from './FamilyRigRenderer'

const css = readFileSync(fileURLToPath(new URL('./family-rig.module.css', import.meta.url)), 'utf8')

describe('family rig renderer', () => {
  it('defines playback selectors for every semantic state', () => {
    for (const state of CHARACTER_STATES) {
      expect(css).toContain(`data-rig-state='${state}'`)
    }
  })

  it('gives each anatomy family distinct attention, speech, and celebration choreography', () => {
    for (const family of ['compact-creature-v1', 'humanoid-v1', 'morph-v1']) {
      expect(css).toContain(`.${family}[data-rig-state='attention']`)
      expect(css).toContain(`.${family}[data-rig-state='speaking']`)
      expect(css).toContain(`.${family}[data-rig-state='happy']`)
    }
  })

  it('forces a static presentation for explicit reduced motion and asset failure', () => {
    expect(resolveFamilyRigMotion('reduced', false)).toBe('reduced')
    expect(resolveFamilyRigMotion('system', true)).toBe('reduced')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain(".rig[data-rig-motion='system']")
  })

  it('provides semantic choreography for declared custom rig families', () => {
    expect(css).toContain(".customRig[data-rig-state='speaking']")
    expect(css).toContain(".customRig[data-rig-state='attention']")
    expect(css).toContain(".customRig[data-rig-state='success']")
  })
})
