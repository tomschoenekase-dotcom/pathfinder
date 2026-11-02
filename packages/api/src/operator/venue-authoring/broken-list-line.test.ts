import { describe, expect, it } from 'vitest'

import { VenuePackagePayload } from '../../schemas/venue-package'
import { venuePackageAuthoringFindings } from './authoring-checks'

// All names and content in these fixtures are fictional.
const NOW = new Date('2026-10-29T15:00:00Z')

function broken(content: string, title = 'Dining overview') {
  const payload = VenuePackagePayload.parse({
    schemaVersion: 1,
    places: [],
    knowledgeEntries: [{ title, category: 'Visiting', content }],
  })
  return venuePackageAuthoringFindings(payload, NOW).filter(
    (finding) => finding.code === 'BROKEN_LIST_LINE',
  )
}

describe('BROKEN_LIST_LINE authoring advisory', () => {
  it.each([
    'Acorn Grill — restaurant;\nnear West Gate.',
    'Acorn Grill — restaurant.\nEast Mall.',
    'Acorn Grill – restaurant;\nmain entrance.',
    'Acorn Grill - restaurant;\nLake Quill.',
    'Acorn Grill — restaurant;\r\nLakeside Crossing.',
  ])('identifies a detached location in an overview: %s', (content) => {
    expect(broken(content)).toEqual([
      expect.objectContaining({
        code: 'BROKEN_LIST_LINE',
        path: 'knowledgeEntries.0.content',
        message: expect.any(String),
        fix: expect.any(String),
      }),
    ])
  })

  it('reports one field advisory even when several members have detached locations', () => {
    expect(
      broken('Acorn Grill — restaurant;\nEast Mall.\nQuill Cafe — cafe;\nnear North Gate.'),
    ).toHaveLength(1)
  })

  it.each([
    'Acorn Grill — restaurant; East Mall.\nQuill Cafe — cafe; North Mall.',
    'Acorn Grill — restaurant.\nNear West Gate, staff can answer questions.',
    'Acorn Grill — restaurant.\nOutside food is prohibited.',
    'Acorn Grill — restaurant.\nAsk staff at the main entrance.',
    'Acorn Grill — restaurant.\nAt the counter, check ingredients before ordering.',
    'Acorn Grill — restaurant.\nQuill Cafe — cafe; North Mall.',
    'Acorn Grill — restaurant.\nLocation: East Mall.',
    'Acorn Grill — restaurant.\n- East Mall.',
    'Acorn Grill — restaurant.\n## East Mall',
    'Acorn Grill — restaurant.\n1. East Mall.',
    'Acorn Grill — restaurant.\n\nEast Mall.',
    'Acorn Grill — restaurant.\nThe Wild.',
    'Acorn Grill — restaurant.\nSandwiches and salads.',
    'Acorn Grill\nnear West Gate.',
    'Meeting locations: restaurant;\nEast Mall.',
    '# Meeting locations — restaurant;\nEast Mall.',
  ])('does not infer breakage from ordinary or ambiguous text: %s', (content) => {
    expect(broken(content)).toEqual([])
  })

  it('does not apply the overview layout convention to an ordinary policy topic', () => {
    expect(broken('Meeting point: start here.\nEast Mall.', 'Group meeting details')).toEqual([])
  })

  it('ignores disabled knowledge entries', () => {
    const payload = VenuePackagePayload.parse({
      schemaVersion: 1,
      places: [],
      knowledgeEntries: [
        {
          title: 'Dining overview',
          category: 'Visiting',
          isEnabled: false,
          content: 'Acorn Grill — restaurant;\nEast Mall.',
        },
      ],
    })
    expect(
      venuePackageAuthoringFindings(payload, NOW).filter(
        (finding) => finding.code === 'BROKEN_LIST_LINE',
      ),
    ).toEqual([])
  })
})
