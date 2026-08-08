import { describe, expect, it } from 'vitest'

import { assignMediaSourceIds, MAX_MEDIA_SOURCE_ID_LENGTH } from './media-source-id'

describe('assignMediaSourceIds', () => {
  it('preserves distinct human labels', () => {
    expect(
      assignMediaSourceIds([
        { filename: 'room/P001-front.jpg' },
        { filename: 'room/V002-walkthrough.mp4' },
      ]).map(({ sourceId }) => sourceId),
    ).toEqual(['P001', 'V002'])
  })

  it('keeps colliding labels distinct without crossing file metadata', () => {
    const files = [
      { filename: 'room-a/P001-front.jpg', bytes: 101, marker: 'front' },
      { filename: 'room-b/P001-label.jpg', bytes: 202, marker: 'label' },
    ]
    const assigned = assignMediaSourceIds(files)

    expect(assigned[0]).toEqual({
      filename: 'room-a/P001-front.jpg',
      bytes: 101,
      marker: 'front',
      sourceId: 'P001',
    })
    expect(assigned[1]).toMatchObject({
      filename: 'room-b/P001-label.jpg',
      bytes: 202,
      marker: 'label',
    })
    expect(assigned[1]!.sourceId).toMatch(/^P001-00002-[0-9a-f]{12}$/u)
    expect(new Set(assigned.map(({ sourceId }) => sourceId)).size).toBe(2)
    expect(assignMediaSourceIds(files)).toEqual(assigned)
  })

  it('distinguishes duplicate identical archive paths by ordinal', () => {
    const assigned = assignMediaSourceIds([
      { filename: 'room/P001.jpg' },
      { filename: 'room/P001.jpg' },
      { filename: 'room/P001.jpg' },
    ])

    expect(new Set(assigned.map(({ sourceId }) => sourceId)).size).toBe(3)
    expect(assigned.map(({ sourceId }) => sourceId)).toEqual([
      'P001',
      expect.stringMatching(/^P001-00002-/u),
      expect.stringMatching(/^P001-00003-/u),
    ])
  })

  it('treats human labels case-insensitively across path separators', () => {
    const assigned = assignMediaSourceIds([
      { filename: 'room/P001-front.jpg' },
      { filename: 'ROOM\\p001-label.jpg' },
    ])

    expect(assigned[0]!.sourceId).toBe('P001')
    expect(assigned[1]!.sourceId).toMatch(/^P001-00002-/u)
  })

  it('uses unique deterministic ordinal identities when no human label exists', () => {
    const files = [{ filename: 'lobby.jpg' }, { filename: 'map.png' }]
    expect(assignMediaSourceIds(files).map(({ sourceId }) => sourceId)).toEqual(['S0001', 'S0002'])
    expect(assignMediaSourceIds(files)).toEqual(assignMediaSourceIds(files))
  })

  it('keeps every generated identity within its storage contract', () => {
    const assigned = assignMediaSourceIds([
      { filename: `${'deep/'.repeat(50)}P1234-first.jpg` },
      { filename: `${'other/'.repeat(50)}P1234-second.jpg` },
    ])

    expect(assigned.every(({ sourceId }) => sourceId.length <= MAX_MEDIA_SOURCE_ID_LENGTH)).toBe(
      true,
    )
  })
})
