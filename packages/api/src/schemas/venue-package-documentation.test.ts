import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  VENUE_PACKAGE_ITEM_LIMIT,
  VENUE_PACKAGE_LATEST_SCHEMA_VERSION,
  VenuePackagePayload,
} from './venue-package'

const documentationPath = fileURLToPath(
  new URL('../../../../docs/venue-package-format.md', import.meta.url),
)
const documentation = readFileSync(documentationPath, 'utf8').replaceAll('\r\n', '\n')

function documentedExample(version: 1 | 2 | 3): unknown {
  const marker = `<!-- venue-package-example:v${version} -->`
  const markerOffset = documentation.indexOf(marker)
  expect(markerOffset, `missing V${version} example marker`).toBeGreaterThanOrEqual(0)

  const tail = documentation.slice(markerOffset + marker.length)
  const match = tail.match(/^\s*```json\s*\r?\n([\s\S]*?)\r?\n```/)
  expect(match, `missing JSON fence after V${version} example marker`).not.toBeNull()
  return JSON.parse(match![1]!)
}

describe('venue package operator documentation', () => {
  it('keeps every documented example executable against the runtime schema', () => {
    for (const version of [1, 2, 3] as const) {
      const example = documentedExample(version)
      const parsed = VenuePackagePayload.parse(example)
      expect(parsed.schemaVersion).toBe(version)
    }
  })

  it('states the live version and aggregate item limit', () => {
    expect(documentation).toContain(
      `Current latest version: \`${VENUE_PACKAGE_LATEST_SCHEMA_VERSION}\``,
    )
    expect(documentation).toContain(`at most **${VENUE_PACKAGE_ITEM_LIMIT}** total`)
  })

  it('documents strict rejection instead of implying unknown keys are ignored', () => {
    expect(documentation).toContain(
      'Unknown keys at the root or inside nested objects are rejected',
    )

    for (const version of [1, 2, 3] as const) {
      const example = documentedExample(version) as Record<string, unknown>
      expect(VenuePackagePayload.safeParse({ ...example, unsupportedField: true }).success).toBe(
        false,
      )
    }
  })

  it('keeps current architecture boundaries explicit', () => {
    expect(documentation).toContain(
      "`itemType` is optional and is independent of the venue's guide mode",
    )
    expect(documentation).toContain('No schema version accepts audience')
    expect(documentation).toContain('denies access before retrieval or model ingress')
  })

  it('documents semantic analysis and location-mode gates without collapsing them into parsing', () => {
    expect(documentation).toContain('Semantic duplicate status is\n   `NOT_RUN`')
    expect(documentation).toContain('Saving performs semantic duplicate analysis')
    expect(documentation).toContain('An authorized owner separately acknowledges')
    expect(documentation).toContain('Only owners can approve, apply, or revert them')
    expect(documentation).toContain('For a `location_aware` venue')
    expect(documentation).toContain('An active V3 place update must also retain coordinates')
    expect(documentation).toContain('update desired state accepts legacy `itemType` strings')
  })
})
