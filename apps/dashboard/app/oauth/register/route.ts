export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { handleClientRegistration } from '@pathfinder/api/operator'

/** RFC 7591 public-client registration with redirect allowlist and rate limits. */
export async function POST(request: Request) {
  return handleClientRegistration(request)
}
