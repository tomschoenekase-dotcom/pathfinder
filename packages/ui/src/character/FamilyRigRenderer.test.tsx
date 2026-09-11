import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { CHARACTER_STATES } from '@pathfinder/contracts/character-system'

import {
  familyRigAssetIdentity,
  familyRigLayerIdentity,
  resolveFamilyRigMotion,
} from './FamilyRigRenderer'

const css = readFileSync(fileURLToPath(new URL('./family-rig.module.css', import.meta.url)), 'utf8')

describe('family rig renderer', () => {
  it('encodes source, fallback, and ordered layer tuples without delimiter collisions', () => {
    const base = { source: 'a', fallbackSource: 'b', layers: [] }
    const pairs = [
      [
        { ...base, source: 'a|b', fallbackSource: 'c' },
        { ...base, fallbackSource: 'b|c' },
      ],
      [
        { ...base, layers: [{ role: 'body:skin', source: 'x' }] },
        { ...base, layers: [{ role: 'body', source: 'skin:x' }] },
      ],
      [
        { ...base, layers: [{ role: 'a', source: 'b|c:d' }] },
        {
          ...base,
          layers: [
            { role: 'a', source: 'b' },
            { role: 'c', source: 'd' },
          ],
        },
      ],
    ]
    const oldIdentity = (props: Parameters<typeof familyRigAssetIdentity>[0]) =>
      `${props.source}|${props.fallbackSource}|${props.layers?.map((layer) => `${layer.role}:${layer.source}`).join('|') ?? ''}`

    for (const [a, b] of pairs) {
      expect(oldIdentity(a!)).toBe(oldIdentity(b!))
      expect(familyRigAssetIdentity(a!)).not.toBe(familyRigAssetIdentity(b!))
    }
    const layers = [
      { role: 'body', source: 'one' },
      { role: 'face', source: 'two' },
    ]
    expect(familyRigAssetIdentity({ ...base, layers })).not.toBe(
      familyRigAssetIdentity({ ...base, layers: [...layers].reverse() }),
    )
  })

  it('uses unambiguous position-aware React layer keys, including identical repeated layers', () => {
    const a = { role: 'body:skin', source: 'x' }
    const b = { role: 'body', source: 'skin:x' }
    expect(`${a.role}:${a.source}`).toBe(`${b.role}:${b.source}`)
    expect(familyRigLayerIdentity(a, 0)).not.toBe(familyRigLayerIdentity(b, 0))
    expect(familyRigLayerIdentity(a, 0)).not.toBe(familyRigLayerIdentity(a, 1))
  })

  it('round trips separator, quote, backslash, empty, and Unicode values in fixed arrays', () => {
    const values = ['', ':', '|', 'a:b|c', '"', '\\', '雪', '[]']
    const identities = new Set<string>()
    for (const source of values) {
      for (const fallbackSource of values) {
        for (const role of values) {
          const identity = familyRigAssetIdentity({
            source,
            fallbackSource,
            layers: [{ role, source }],
          })
          expect(JSON.parse(identity)).toEqual([source, fallbackSource, [[role, source]]])
          identities.add(identity)
        }
      }
    }
    expect(identities.size).toBe(values.length ** 3)
  })

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
