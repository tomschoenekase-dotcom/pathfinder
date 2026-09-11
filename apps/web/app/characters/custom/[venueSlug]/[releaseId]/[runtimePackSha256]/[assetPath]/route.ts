import { readPublishedCustomCharacterAsset } from '@pathfinder/api/custom-character-publication'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Referrer-Policy': 'no-referrer',
}

type AssetParams = {
  venueSlug: string
  releaseId: string
  runtimePackSha256: string
  assetPath: string
}

function valid(input: AssetParams): boolean {
  return (
    input.venueSlug.length <= 191 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.venueSlug) &&
    UUID.test(input.releaseId) &&
    /^[a-f0-9]{64}$/u.test(input.runtimePackSha256) &&
    input.assetPath.length <= 84 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*\.png$/u.test(input.assetPath)
  )
}

export async function GET(
  _request: Request,
  context: { params: Promise<AssetParams> },
): Promise<Response> {
  try {
    const input = await context.params
    if (!valid(input)) return new Response(null, { status: 404, headers })
    // The helper checks current native publication authority and rate admission
    // on every request. Only a bounded raster derivative can leave this route.
    const asset = await readPublishedCustomCharacterAsset(input)
    if (!asset || asset.mediaType !== 'image/png' || asset.bytes.byteLength === 0)
      return new Response(null, { status: 404, headers })
    return new Response(Uint8Array.from(asset.bytes), {
      headers: {
        ...headers,
        'Content-Type': 'image/png',
        'Content-Length': String(asset.bytes.byteLength),
      },
    })
  } catch {
    return new Response(null, { status: 404, headers })
  }
}
