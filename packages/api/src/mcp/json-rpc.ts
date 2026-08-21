import { z } from 'zod'

import { PATHFINDER_MCP_PROTOCOL_VERSION } from '@pathfinder/contracts/mcp-v0'

import type { PathfinderMcpRegistry, VerifiedMcpInvocationContext } from './registry'

const requestId = z.union([z.string().max(191), z.number().int(), z.null()])
const requestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: requestId.optional(),
    method: z.string().trim().min(1).max(191),
    params: z.unknown().optional(),
  })
  .strict()

type JsonRpcId = z.infer<typeof requestId>
type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string; data?: unknown } }
  | null

function error(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  }
}

/**
 * Standards-shaped MCP JSON-RPC dispatcher. Authentication remains outside this
 * transport boundary; callers must supply a server-verified credential context.
 */
export async function dispatchMcpJsonRpc(
  rawRequest: unknown,
  context: VerifiedMcpInvocationContext,
  registry: PathfinderMcpRegistry,
): Promise<JsonRpcResponse> {
  const parsed = requestSchema.safeParse(rawRequest)
  if (!parsed.success) {
    const rawId =
      typeof rawRequest === 'object' && rawRequest !== null && 'id' in rawRequest
        ? requestId.safeParse((rawRequest as { id: unknown }).id)
        : null
    return error(rawId?.success ? rawId.data : null, -32600, 'Invalid Request')
  }
  const request = parsed.data
  const id = request.id ?? null
  const isNotification = request.id === undefined
  try {
    switch (request.method) {
      case 'initialize':
        return isNotification
          ? null
          : {
              jsonrpc: '2.0',
              id,
              result: {
                protocolVersion: PATHFINDER_MCP_PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'torchiko-company-os', version: '1.0.0' },
                instructions:
                  'Use compact operational context first. Search Company Knowledge only when deeper institutional context is required.',
              },
            }
      case 'notifications/initialized':
        return null
      case 'ping':
        return isNotification ? null : { jsonrpc: '2.0', id, result: {} }
      case 'tools/list': {
        const params = z
          .object({ cursor: z.string().optional() })
          .strict()
          .parse(request.params ?? {})
        if (params.cursor)
          return error(id, -32602, 'Invalid params', { reason: 'CURSOR_UNSUPPORTED' })
        return isNotification
          ? null
          : { jsonrpc: '2.0', id, result: { tools: registry.listTools() } }
      }
      case 'tools/call': {
        const params = z
          .object({
            name: z.string().trim().min(1).max(191),
            arguments: z.record(z.unknown()).default({}),
            _meta: z
              .object({ approvalGrantId: z.string().trim().min(1).max(120).optional() })
              .passthrough()
              .optional(),
          })
          .strict()
          .parse(request.params)
        const invocation = {
          credential: context.credential,
          ...(params._meta?.approvalGrantId
            ? { approvalGrantId: params._meta.approvalGrantId }
            : context.approvalGrantId
              ? { approvalGrantId: context.approvalGrantId }
              : {}),
        }
        const result = await registry.callTool(params.name, params.arguments, invocation)
        return isNotification ? null : { jsonrpc: '2.0', id, result }
      }
      default:
        return isNotification ? null : error(id, -32601, 'Method not found')
    }
  } catch (caught) {
    if (isNotification) return null
    if (caught instanceof z.ZodError) {
      return error(id, -32602, 'Invalid params', {
        issues: caught.issues.map((issue) => ({ path: issue.path, code: issue.code })),
      })
    }
    const code =
      caught instanceof Error && 'code' in caught
        ? String((caught as Error & { code: unknown }).code)
        : 'TOOL_CALL_REJECTED'
    return error(id, -32001, 'Tool call rejected', { code })
  }
}
