import { handlePlatformWorkerReleaseEvidenceRequest } from '@pathfinder/api/platform-worker-policy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return handlePlatformWorkerReleaseEvidenceRequest(request)
}
