import { beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

const readPreview = vi.hoisted(() => vi.fn())
vi.mock('../../../../lib/admin-caller', () => ({
  createAdminCaller: async () => ({ admin: { readCharacterCandidatePreview: readPreview } }),
}))
import { GET } from './route'

const input = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  briefId: 'brief-a',
  expectedVersion: '1',
  expectedRevision: '2',
  expectedArtifactFingerprint: 'a'.repeat(64),
}
const request = (overrides = {}) =>
  new Request(
    `https://dashboard.test/api/admin/character-candidate-preview?${new URLSearchParams({ ...input, ...overrides })}`,
  )

describe('authenticated exact character candidate preview', () => {
  beforeEach(() => {
    readPreview.mockReset()
  })

  it('rasterizes verified source SVG into bounded inert PNG with private response headers', async () => {
    readPreview.mockResolvedValue({
      mediaType: 'image/svg+xml',
      sha256: 'b'.repeat(64),
      bytesBase64: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#4b7687"/></svg>',
      ).toString('base64'),
    })
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(await sharp(bytes).metadata()).toMatchObject({ format: 'png', width: 768, height: 512 })
    expect(readPreview).toHaveBeenCalledWith({ ...input, expectedVersion: 1, expectedRevision: 2 })
  })

  it('rejects malformed snapshot requests before reading any artifact', async () => {
    expect((await GET(request({ expectedArtifactFingerprint: 'latest' }))).status).toBe(400)
    expect(readPreview).not.toHaveBeenCalled()
  })

  it.each([
    ['UNAUTHORIZED', 401],
    ['FORBIDDEN', 403],
    ['CONFLICT', 409],
  ])('retains %s denial and never returns exception details', async (code, status) => {
    readPreview.mockRejectedValue(Object.assign(new Error('private artifact reference'), { code }))
    const response = await GET(request())
    expect(response.status).toBe(status)
    expect(await response.text()).not.toContain('private artifact reference')
  })

  it('fails closed for invalid bytes without serving source content', async () => {
    readPreview.mockResolvedValue({
      mediaType: 'image/png',
      bytesBase64: Buffer.from('not an image').toString('base64'),
    })
    const response = await GET(request())
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('not an image')
  })
})
