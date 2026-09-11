import sharp from 'sharp'
import { createAdminCaller } from '../../../../lib/admin-caller'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function parseInput(url: string) {
  const query = new URL(url).searchParams
  const tenantId = query.get('tenantId') ?? ''
  const venueId = query.get('venueId') ?? ''
  const briefId = query.get('briefId') ?? ''
  const expectedVersion = Number(query.get('expectedVersion'))
  const expectedRevision = Number(query.get('expectedRevision'))
  const expectedArtifactFingerprint = query.get('expectedArtifactFingerprint') ?? ''
  if (
    [tenantId, venueId, briefId].some((value) => !value.trim() || value.length > 191) ||
    ![expectedVersion, expectedRevision].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    !/^[a-f0-9]{64}$/u.test(expectedArtifactFingerprint)
  )
    return null
  return {
    tenantId,
    venueId,
    briefId,
    expectedVersion,
    expectedRevision,
    expectedArtifactFingerprint,
  }
}

const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
}

export async function GET(request: Request) {
  const input = parseInput(request.url)
  if (!input) return new Response('Invalid candidate preview request.', { status: 400, headers })
  try {
    const caller = await createAdminCaller()
    const asset = await caller.admin.readCharacterCandidatePreview(input)
    // The admin reader verifies the exact stored bundle and master provenance. Never
    // pass a URL to the rasterizer or return source SVG to the browser.
    if (
      !['image/png', 'image/svg+xml'].includes(asset.mediaType) ||
      asset.bytesBase64.length > 2_666_668 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(asset.bytesBase64)
    )
      throw new Error('Invalid preview asset')
    const bytes = Buffer.from(asset.bytesBase64, 'base64')
    if (bytes.length === 0 || bytes.length > 2_000_000) throw new Error('Invalid preview size')
    const png = await sharp(bytes, {
      limitInputPixels: 16_777_216,
      failOn: 'error',
      animated: false,
    })
      .resize(768, 768, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()
    return new Response(new Uint8Array(png), {
      headers: { ...headers, 'Content-Type': 'image/png' },
    })
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    const status =
      code === 'UNAUTHORIZED' ? 401 : code === 'FORBIDDEN' ? 403 : code === 'CONFLICT' ? 409 : 404
    return new Response('Candidate preview is unavailable. Refresh the review.', {
      status,
      headers,
    })
  }
}
