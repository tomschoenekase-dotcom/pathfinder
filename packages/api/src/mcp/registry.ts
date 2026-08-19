import {
  assertMcpScope,
  MCP_RESOURCE_SECURITY_BY_KIND,
  McpAskOperatorInput,
  McpDelegateSpecialistInput,
  McpEvaluationRequestInput,
  McpPackageDraftInput,
  McpReadInput,
  McpSupportDraftInput,
  McpToolResult,
  McpUpdateDraftInput,
  PATHFINDER_MCP_TOOLS,
  toMcpStructuredResult,
  VerifiedMcpCredentialScope,
  type PathfinderMcpToolName,
} from '@pathfinder/contracts/mcp-v0'

/**
 * The embedding server must construct this context from its canonical authentication,
 * authorization, and approval services. Tool arguments are never authority.
 */
export type VerifiedMcpInvocationContext = Readonly<{
  credential: VerifiedMcpCredentialScope
  /** Opaque evidence already verified by the canonical approval boundary. */
  approvalGrantId?: string
}>

/**
 * Thin adapter surface only. Implementations must call the same canonical domain actions used by
 * the first-party UI/API; they must not reproduce authorization or business logic here.
 */
export type PathfinderMcpDomainActions = Readonly<{
  verifyApprovalGrant: (
    request: Readonly<{
      approvalGrantId: string
      toolName: Exclude<
        PathfinderMcpToolName,
        'pathfinder.read' | 'pathfinder.ask_operator' | 'pathfinder.delegate_specialist'
      >
      clientId: string
      venueId: string
      capability: string
    }>,
    context: VerifiedMcpInvocationContext,
  ) => Promise<void>
  read: (input: McpReadInput, context: VerifiedMcpInvocationContext) => Promise<McpToolResult>
  askOperator: (
    input: McpAskOperatorInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  delegateSpecialist: (
    input: McpDelegateSpecialistInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  createPackageDraft: (
    input: McpPackageDraftInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  createUpdateDraft: (
    input: McpUpdateDraftInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  createSupportDraft: (
    input: McpSupportDraftInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  requestEvaluation: (
    input: McpEvaluationRequestInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
}>

export class PathfinderMcpRegistryError extends Error {
  constructor(
    readonly code: 'UNKNOWN_TOOL' | 'WRITE_TOOLS_DISABLED' | 'APPROVAL_REQUIRED',
    message: string,
  ) {
    super(message)
  }
}

export type PathfinderMcpRegistry = Readonly<{
  listTools: () => typeof PATHFINDER_MCP_TOOLS
  callTool: (
    name: string,
    arguments_: unknown,
    context: VerifiedMcpInvocationContext,
  ) => Promise<ReturnType<typeof toMcpStructuredResult>>
}>

const definitionsByName = new Map(
  PATHFINDER_MCP_TOOLS.map((definition) => [definition.name, definition]),
)

/** Creates no listener and performs no authentication or I/O until an injected action is called. */
export function createPathfinderMcpRegistry(
  actions: PathfinderMcpDomainActions,
  options: Readonly<{ writeToolsEnabled?: boolean }> = {},
): PathfinderMcpRegistry {
  const writeToolsEnabled = options.writeToolsEnabled ?? false

  return {
    listTools: () => PATHFINDER_MCP_TOOLS,
    async callTool(name, arguments_, rawContext) {
      const definition = definitionsByName.get(name)
      if (!definition) throw new PathfinderMcpRegistryError('UNKNOWN_TOOL', `Unknown tool: ${name}`)

      const context: VerifiedMcpInvocationContext = {
        credential: VerifiedMcpCredentialScope.parse(rawContext.credential),
        ...(rawContext.approvalGrantId !== undefined
          ? { approvalGrantId: zApprovalGrantId(rawContext.approvalGrantId) }
          : {}),
      }
      const metadata = definition._meta['com.pathfinder/security']
      if (metadata.approvalRequired) {
        if (!writeToolsEnabled) {
          throw new PathfinderMcpRegistryError(
            'WRITE_TOOLS_DISABLED',
            'MCP write tools are disabled',
          )
        }
        if (!context.approvalGrantId) {
          throw new PathfinderMcpRegistryError(
            'APPROVAL_REQUIRED',
            'A verified approval grant is required',
          )
        }
      }

      let result: McpToolResult
      switch (name as PathfinderMcpToolName) {
        case 'pathfinder.read': {
          const input = McpReadInput.parse(arguments_)
          const resourceSecurity = MCP_RESOURCE_SECURITY_BY_KIND[input.resource]!
          assertMcpScope(context.credential, input, 'resources:read', resourceSecurity.scope)
          assertMcpScope(
            context.credential,
            input,
            resourceSecurity.capability,
            resourceSecurity.scope,
          )
          result = await actions.read(input, context)
          break
        }
        case 'pathfinder.ask_operator': {
          const input = McpAskOperatorInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'venue')
          result = await actions.askOperator(input, context)
          break
        }
        case 'pathfinder.delegate_specialist': {
          const input = McpDelegateSpecialistInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'venue')
          result = await actions.delegateSpecialist(input, context)
          break
        }
        case 'pathfinder.create_package_draft': {
          const input = McpPackageDraftInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'venue')
          await verifyApproval(
            actions,
            'pathfinder.create_package_draft',
            input,
            metadata.capability,
            context,
          )
          result = await actions.createPackageDraft(input, context)
          break
        }
        case 'pathfinder.create_update_draft': {
          const input = McpUpdateDraftInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'venue')
          await verifyApproval(
            actions,
            'pathfinder.create_update_draft',
            input,
            metadata.capability,
            context,
          )
          result = await actions.createUpdateDraft(input, context)
          break
        }
        case 'pathfinder.create_support_draft': {
          const input = McpSupportDraftInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'venue')
          await verifyApproval(
            actions,
            'pathfinder.create_support_draft',
            input,
            metadata.capability,
            context,
          )
          result = await actions.createSupportDraft(input, context)
          break
        }
        case 'pathfinder.request_evaluation': {
          const input = McpEvaluationRequestInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'venue')
          await verifyApproval(
            actions,
            'pathfinder.request_evaluation',
            input,
            metadata.capability,
            context,
          )
          result = await actions.requestEvaluation(input, context)
          break
        }
      }

      return toMcpStructuredResult(McpToolResult.parse(result))
    },
  }
}

async function verifyApproval(
  actions: PathfinderMcpDomainActions,
  toolName: Exclude<
    PathfinderMcpToolName,
    'pathfinder.read' | 'pathfinder.ask_operator' | 'pathfinder.delegate_specialist'
  >,
  scope: Readonly<{ clientId: string; venueId?: string | undefined }>,
  capability: string,
  context: VerifiedMcpInvocationContext,
): Promise<void> {
  if (!context.approvalGrantId || !scope.venueId) {
    throw new PathfinderMcpRegistryError(
      'APPROVAL_REQUIRED',
      'A verified approval grant is required',
    )
  }
  await actions.verifyApprovalGrant(
    {
      approvalGrantId: context.approvalGrantId,
      toolName,
      clientId: scope.clientId,
      venueId: scope.venueId,
      capability,
    },
    context,
  )
}

function zApprovalGrantId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 120) {
    throw new PathfinderMcpRegistryError('APPROVAL_REQUIRED', 'Approval grant is invalid')
  }
  return value
}
