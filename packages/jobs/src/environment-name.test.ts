import { describe, expect, it } from 'vitest'

import { environmentQueueName } from './environment-name'

describe('environmentQueueName', () => {
  it('preserves production queue names for backward compatibility', () => {
    expect(environmentQueueName('production', 'media-ingestion')).toBe('media-ingestion')
  })

  it('isolates staging and preview queues from production and each other', () => {
    expect(environmentQueueName('staging', 'media-ingestion')).toBe('staging:media-ingestion')
    expect(environmentQueueName('preview', 'media-ingestion')).toBe('preview:media-ingestion')
  })
})
