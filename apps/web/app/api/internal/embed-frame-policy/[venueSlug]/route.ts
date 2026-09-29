import { timingSafeEqual } from 'node:crypto'

import { NextResponse } from 'next/server'

import { resolveCachedVenueDistribution } from '@pathfinder/db'

export const runtime = 'nodejs'

const POLICY_TOKEN_HEADER = 'x-torchiko-internal-policy-token'
const NO_STORE = { 'Cache-Control': 'no-store' }

function hasValidPolicyToken(candidate: string | null, expected: string | undefined): boolean {
  if (!candidate || !expected) return false
  const candidateBytes = Buffer.from(candidate, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  const candidatePadded = Buffer.alloc(512)
  const expectedPadded = Buffer.alloc(512)
  candidateBytes.copy(candidatePadded, 0, 0, 512)
  expectedBytes.copy(expectedPadded, 0, 0, 512)
  const equalPadded = timingSafeEqual(candidatePadded, expectedPadded)
  return (
    equalPadded && candidateBytes.length === expectedBytes.length && candidateBytes.length <= 512
  )
}

export async function GET(request: Request, context: { params: Promise<{ venueSlug: string }> }) {
  if (
    !hasValidPolicyToken(
      request.headers.get(POLICY_TOKEN_HEADER),
      process.env.INTERNAL_POLICY_TOKEN,
    )
  ) {
    return new Response(null, { status: 404, headers: NO_STORE })
  }
  const { venueSlug } = await context.params
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(venueSlug) || venueSlug.length > 200) {
    return NextResponse.json({ origins: [] }, { headers: NO_STORE })
  }
  try {
    const policy = await resolveCachedVenueDistribution({ venueSlug })
    return NextResponse.json(
      { origins: policy?.website.effective ? policy.website.origins : [] },
      { headers: NO_STORE },
    )
  } catch {
    return NextResponse.json({ origins: [] }, { headers: NO_STORE })
  }
}
