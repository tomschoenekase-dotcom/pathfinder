import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { OPERATOR_MCP_OUTPUTS } from '@pathfinder/contracts/operator-mcp'
import { TONE_PRESET_IDS } from '@pathfinder/contracts/tone-presets'

import { guestResponseWordLimit } from '../../lib/venue-context'
import { venuePackageGuideQualityWarnings } from '../../lib/venue-guide-quality'
import { VenuePackagePayload } from '../../schemas/venue-package'
import type { OperatorCallContext } from '../registry'
import { manualReadTools } from '../tools/manual'
import { venuePackageAuthoringFindings } from './authoring-checks'
import { explainVenuePackageIssues } from './package-issues'
import { VENUE_AUTHORING_TEXT } from './venue-authoring-text'

/** Every venue, place and source here is fictional. */
const NOW = new Date('2026-10-27T15:00:00Z')
const docPath = fileURLToPath(
  new URL('../../../../../docs/operator/venue-authoring.md', import.meta.url),
)
const doc = readFileSync(docPath, 'utf8').replaceAll('\r\n', '\n')

function fences(kind: 'example' | 'mistake') {
  const marker = new RegExp(
    `<!-- venue-authoring-${kind}:([a-z-]+)(?: expect=([A-Z_,]+))? -->\\s*\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``,
    'gu',
  )
  return [...doc.matchAll(marker)].map((match) => ({
    name: match[1]!,
    expect: match[2]?.split(',') ?? [],
    json: JSON.parse(match[3]!) as unknown,
  }))
}

/** What venues.check_package reports, minus the database-backed preview. */
function check(json: unknown) {
  const parsed = VenuePackagePayload.safeParse(json)
  if (!parsed.success) {
    return {
      errors: explainVenuePackageIssues(parsed.error.issues, json),
      quality: [],
      authoring: [],
    }
  }
  return {
    errors: [],
    quality: venuePackageGuideQualityWarnings(parsed.data, { today: '2026-10-27' }),
    authoring: venuePackageAuthoringFindings(parsed.data, NOW),
  }
}

describe('venue authoring contract', () => {
  it('serves exactly the doc through operator.get_manual, with a schema from the live validator', async () => {
    expect(VENUE_AUTHORING_TEXT).toBe(doc)
    const tool = manualReadTools.find((entry) => entry.name === 'operator.get_manual')!
    const output = await tool.handler({ section: 'venue-authoring' }, {} as OperatorCallContext)
    const parsed = OPERATOR_MCP_OUTPUTS['operator.get_manual'].parse(output)
    expect(parsed.text).toBe(doc)
    const schema = parsed.schema as {
      properties: Record<string, { const?: number; properties?: Record<string, unknown> }>
      required: string[]
    }
    expect(schema.properties.schemaVersion?.const).toBe(3)
    expect(schema.required).toEqual(
      expect.arrayContaining(['schemaVersion', 'places', 'knowledgeEntries']),
    )
    expect(JSON.stringify(schema)).toContain('contentOrigin')
    expect(JSON.stringify(schema)).toContain('HUMAN_AUTHORED')
    // The full manual still comes back by default and names the section.
    const full = OPERATOR_MCP_OUTPUTS['operator.get_manual'].parse(
      await tool.handler({}, {} as OperatorCallContext),
    )
    expect(full.sections).toContain('venue-authoring')
    await expect(tool.handler({ section: 'other' }, {} as OperatorCallContext)).rejects.toThrow()
  })

  it('has a complete example and hard cases that pass the schema, writing guide and meaning checks', () => {
    const examples = fences('example')
    expect(examples.map((example) => example.name)).toEqual([
      'complete',
      'recurring-event',
      'conflict-and-unknown',
      'update-and-retire',
    ])
    for (const example of examples) {
      const result = check(example.json)
      expect(result, example.name).toEqual({ errors: [], quality: [], authoring: [] })
    }
    const complete = VenuePackagePayload.parse(examples[0]!.json)
    if (complete.schemaVersion !== 3) throw new Error('complete example must be version 3')
    expect(complete.places.create.length).toBeGreaterThanOrEqual(3)
    expect(complete.knowledgeEntries.create.map((entry) => entry.value.title)).toEqual(
      expect.arrayContaining(['Hours and season', 'Tickets and prices', 'Severe weather']),
    )
  })

  it('shows mistakes that produce exactly the codes the doc names', () => {
    const mistakes = fences('mistake')
    expect(mistakes.length).toBeGreaterThanOrEqual(2)
    for (const mistake of mistakes) {
      const result = check(mistake.json)
      const codes = new Set([...result.errors, ...result.authoring].map((finding) => finding.code))
      for (const code of mistake.expect) expect([...codes], mistake.name).toContain(code)
      for (const finding of [...result.errors, ...result.authoring]) {
        expect(finding.fix.length, `${mistake.name} ${finding.code}`).toBeGreaterThan(20)
      }
    }
  })

  it('states the live voice settings and response lengths', () => {
    for (const preset of TONE_PRESET_IDS) expect(doc).toContain(`\`${preset}\``)
    for (const depth of ['BRIEF', 'BALANCED', 'DETAILED'] as const) {
      const words = guestResponseWordLimit(depth, 'DEFAULT')
      const expand = guestResponseWordLimit(depth, 'EXPAND')
      expect(doc).toContain(`\`${depth}\` (about ${words} words; ${expand}`)
    }
  })

  it('marks schedules as planned and rejects them today with that explanation', () => {
    expect(doc).toContain('**Planned, not available:**')
    const json = {
      schemaVersion: 3,
      places: {},
      knowledgeEntries: {
        create: [
          {
            itemKey: '7f1c2b9e-7a4d-4e1b-9c2a-5d6e7f8a9b0c',
            provenance: { sourceType: 'official_website', contentOrigin: 'AI_GENERATED' },
            value: {
              title: 'Lantern Nights',
              category: 'Events',
              content: 'A light walk.',
              schedule: {},
            },
          },
        ],
      },
    }
    const [error] = check(json).errors
    expect(error).toMatchObject({
      code: 'UNKNOWN_FIELD',
      path: 'knowledgeEntries.create.0.value.schedule',
    })
    expect(error!.fix).toMatch(/planned but not available/u)
  })
})
