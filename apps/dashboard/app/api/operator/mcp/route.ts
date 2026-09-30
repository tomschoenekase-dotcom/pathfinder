export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { handleOperatorMcpRequest } from '@pathfinder/api/operator'

/** The Dot operator MCP resource. OAuth bearer only; 404 unless OPERATOR_OAUTH_ENABLED. */
export async function POST(request: Request) {
  return handleOperatorMcpRequest(request)
}

export async function GET(request: Request) {
  return handleOperatorMcpRequest(request)
}
