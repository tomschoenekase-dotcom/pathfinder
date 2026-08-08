import { describe, expect, it } from 'vitest'

import { planMediaUploadResume } from './media-upload-resume'

describe('media upload resume plan', () => {
  it('preserves completed ETags, skips their part numbers, and restores progress bytes', () => {
    expect(
      planMediaUploadResume(4, [
        { partNumber: 3, etag: 'three', size: 7 },
        { partNumber: 1, etag: 'one', size: 16 },
      ]),
    ).toEqual({
      parts: [
        { partNumber: 3, etag: 'three' },
        { partNumber: 1, etag: 'one' },
      ],
      remainingPartNumbers: [2, 4],
      uploadedBytes: 23,
    })
  })

  it('rejects duplicate, out-of-range, and invalid resume state', () => {
    expect(() => planMediaUploadResume(0, [])).toThrow(/positive safe integer/)
    expect(() =>
      planMediaUploadResume(2, [
        { partNumber: 1, etag: 'one', size: 16 },
        { partNumber: 1, etag: 'duplicate', size: 16 },
      ]),
    ).toThrow(/resume state is invalid/)
    expect(() => planMediaUploadResume(2, [{ partNumber: 3, etag: 'three', size: 1 }])).toThrow(
      /resume state is invalid/,
    )
    expect(() => planMediaUploadResume(2, [{ partNumber: 1, etag: '', size: 1 }])).toThrow(
      /resume state is invalid/,
    )
    expect(() => planMediaUploadResume(2, [{ partNumber: 1, etag: 'one', size: 0 }])).toThrow(
      /resume state is invalid/,
    )
  })
})
