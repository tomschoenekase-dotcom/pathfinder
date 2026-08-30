import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { FounderDecisionPacket } from './company-brain'

const packet = {
  schemaVersion: 'founder-decision-packet.v1' as const,
  packetId: 'founder-direction-2026-08-22',
  title: 'Founder direction',
  effectiveAt: '2026-08-22T00:00:00.000-05:00',
  sourceRef: 'vault://07 Decisions/Torchiko Founder Engineering Direction 2026-08-22.md',
  decisions: [
    {
      key: 'codex-autonomy',
      title: 'Codex autonomy',
      summary: 'Ordinary engineering decisions are delegated to Codex.',
      decision: 'Make the best reasonable technical choice and keep moving.',
      rationale: 'Founder review should be reserved for founder judgment.',
      affectedSystems: ['engineering'],
      scope: { environment: 'local-and-staging', productionAuthorized: false },
    },
  ],
}

describe('FounderDecisionPacket', () => {
  it('accepts a bounded, source-linked packet', () => {
    expect(FounderDecisionPacket.parse(packet)).toEqual(packet)
  })

  it('rejects duplicate or unstable decision keys', () => {
    expect(() =>
      FounderDecisionPacket.parse({
        ...packet,
        decisions: [...packet.decisions, packet.decisions[0]],
      }),
    ).toThrow(/unique/u)
    expect(() =>
      FounderDecisionPacket.parse({
        ...packet,
        decisions: [{ ...packet.decisions[0], key: 'Codex autonomy' }],
      }),
    ).toThrow()
  })

  it('validates the checked-in August 22 founder direction packet', () => {
    const source = readFileSync(
      resolve(process.cwd(), '../../docs/founder-decision-packet-2026-08-22.json'),
      'utf8',
    )
    const parsed = FounderDecisionPacket.parse(JSON.parse(source))
    expect(parsed.packetId).toBe('torchiko-founder-direction-2026-08-22')
    expect(parsed.decisions).toHaveLength(22)
    expect(parsed.decisions.every((decision) => decision.scope.productionAuthorized !== true)).toBe(
      true,
    )
  })
})
