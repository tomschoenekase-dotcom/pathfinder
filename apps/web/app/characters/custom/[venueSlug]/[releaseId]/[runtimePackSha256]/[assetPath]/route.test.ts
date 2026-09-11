import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@pathfinder/api/custom-character-publication', () => ({
  readPublishedCustomCharacterAsset: mocks.read,
}))

import { GET } from './route'

const valid = {
  venueSlug: 'synthetic-museum',
  releaseId: '11111111-1111-4111-8111-111111111111',
  runtimePackSha256: 'a'.repeat(64),
  assetPath: 'body.png',
}
const request = new Request('https://fixture.invalid/characters/custom/example')
const read = (input = valid) => GET(request, { params: Promise.resolve(input) })

describe('public custom character raster route', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns only the exact publication helper raster with restrictive headers', async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71])
    mocks.read.mockResolvedValue({ bytes, mediaType: 'image/png' })
    const response = await read()
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(valid)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox")
  })

  it('rejects malformed or path-like identities before storage or database work', async () => {
    for (const input of [
      { ...valid, venueSlug: '../other' },
      { ...valid, venueSlug: 'a'.repeat(192) },
      { ...valid, releaseId: 'not-a-release' },
      { ...valid, runtimePackSha256: 'a'.repeat(63) },
      { ...valid, assetPath: '../body.png' },
      { ...valid, assetPath: 'body.svg' },
      { ...valid, assetPath: 'body.png?source=private' },
    ]) {
      const response = await read(input)
      expect(response.status).toBe(404)
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    }
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('rechecks publication on repeated requests and never serves a withdrawn result', async () => {
    mocks.read
      .mockResolvedValueOnce({ bytes: new Uint8Array([1]), mediaType: 'image/png' })
      .mockResolvedValueOnce(null)
    expect((await read()).status).toBe(200)
    expect((await read()).status).toBe(404)
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it('does not return private error details or raw SVG on helper failure', async () => {
    mocks.read.mockRejectedValueOnce(new Error('private-storage-reference'))
    const failed = await read()
    expect(failed.status).toBe(404)
    expect(await failed.text()).toBe('')
    mocks.read.mockResolvedValueOnce({ bytes: new Uint8Array([1]), mediaType: 'image/svg+xml' })
    expect((await read()).status).toBe(404)
  })
})
