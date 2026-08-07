import { describe, expect, it } from 'vitest'

import { buildKnowledgeEntryText, buildPlaceText } from './content-text'

describe('embedding content text', () => {
  it('builds the canonical place text without blank fields', () => {
    expect(
      buildPlaceText({
        name: 'North Gallery',
        type: 'gallery',
        itemType: 'Exhibit Hall',
        shortDescription: 'Modern works',
        longDescription: null,
        tags: ['art', 'quiet'],
        areaName: 'Second floor',
        hours: '10:00-17:00',
      }),
    ).toBe('North Gallery. Exhibit Hall. Second floor. Modern works. art quiet. Hours: 10:00-17:00')
  })

  it('builds canonical knowledge text', () => {
    expect(
      buildKnowledgeEntryText({
        title: 'Refund policy',
        category: 'Policy',
        content: 'Refunds are available within 30 days.',
      }),
    ).toBe('Refund policy. Policy. Refunds are available within 30 days.')
  })
})
