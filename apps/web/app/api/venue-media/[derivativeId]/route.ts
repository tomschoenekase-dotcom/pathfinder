import { readControlledVenueMediaDerivative } from '@pathfinder/api/venue-media-delivery'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export async function GET(
  request: Request,
  context: { params: Promise<{ derivativeId: string }> },
): Promise<Response> {
  const { derivativeId } = await context.params
  const venueSlug = new URL(request.url).searchParams.get('venue')?.trim() ?? ''
  if (!UUID.test(derivativeId) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(venueSlug)) {
    return new Response('Not found', { status: 404 })
  }
  try {
    const result = await readControlledVenueMediaDerivative({ derivativeId, venueSlug })
    return new Response(Uint8Array.from(result.bytes), {
      status: 200,
      headers: {
        'Content-Type': result.mimeType,
        'Content-Length': String(result.bytes.byteLength),
        'Cache-Control': 'private, max-age=0, no-store',
        ETag: `"sha256-${result.sha256}"`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return new Response('Not found', {
      status: 404,
      headers: { 'Cache-Control': 'private, max-age=0, no-store' },
    })
  }
}
