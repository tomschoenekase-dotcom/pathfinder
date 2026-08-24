import {
  assertMcpScope,
  MCP_RESOURCE_SECURITY_BY_KIND,
  McpAskOperatorInput,
  McpAgentImprovementProposalInput,
  McpAgentImprovementValidationInput,
  McpAccountContextInput,
  McpAccountHistoryInput,
  McpAccountMeetingGetInput,
  McpBillingProposalInput,
  McpCustomerAccessPreparationInput,
  McpDelegateSpecialistInput,
  McpEvaluationRequestInput,
  McpPackageDraftInput,
  McpKnowledgeGetInput,
  McpKnowledgeGapListInput,
  McpKnowledgeCorrectionProposalInput,
  McpLocationDraftProposalInput,
  McpKnowledgeSearchInput,
  McpIntegrationHealthInput,
  McpIntakeNotesProposalInput,
  McpMeetingProcessInput,
  McpReportLifecycleInput,
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
        | 'pathfinder.read'
        | 'torchiko.account.get_context'
        | 'torchiko.account.timeline'
        | 'torchiko.account.meetings'
        | 'torchiko.account.meeting_get'
        | 'torchiko.meeting.process'
        | 'torchiko.account.correspondence'
        | 'torchiko.knowledge.search'
        | 'torchiko.knowledge.get'
        | 'torchiko.knowledge.list_gaps'
        | 'torchiko.knowledge.propose_correction'
        | 'torchiko.locations.propose_draft'
        | 'torchiko.agent_improvements.propose'
        | 'torchiko.agent_improvements.record_validation'
        | 'torchiko.customer_access.prepare_invitation'
        | 'torchiko.integrations.health'
        | 'torchiko.reports.get_lifecycle'
        | 'pathfinder.ask_operator'
        | 'pathfinder.delegate_specialist'
        | 'pathfinder.propose_billing_action'
      >
      clientId: string
      venueId: string
      capability: string
    }>,
    context: VerifiedMcpInvocationContext,
  ) => Promise<void>
  read: (input: McpReadInput, context: VerifiedMcpInvocationContext) => Promise<McpToolResult>
  accountContext: (
    input: McpAccountContextInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  accountTimeline: (
    input: McpAccountHistoryInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  accountMeetings: (
    input: McpAccountHistoryInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  accountMeetingGet: (
    input: McpAccountMeetingGetInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  processMeeting: (
    input: McpMeetingProcessInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  accountCorrespondence: (
    input: McpAccountHistoryInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  knowledgeSearch: (
    input: McpKnowledgeSearchInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  knowledgeGet: (
    input: McpKnowledgeGetInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  listKnowledgeGaps: (
    input: McpKnowledgeGapListInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  proposeKnowledgeCorrection: (
    input: McpKnowledgeCorrectionProposalInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  proposeLocationDraft: (
    input: McpLocationDraftProposalInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  proposeAgentImprovement: (
    input: McpAgentImprovementProposalInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  recordAgentImprovementValidation: (
    input: McpAgentImprovementValidationInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  prepareCustomerAccessInvitation: (
    input: McpCustomerAccessPreparationInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  integrationHealth: (
    input: McpIntegrationHealthInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  reportLifecycle: (
    input: McpReportLifecycleInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  askOperator: (
    input: McpAskOperatorInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  delegateSpecialist: (
    input: McpDelegateSpecialistInput,
    context: VerifiedMcpInvocationContext,
  ) => Promise<McpToolResult>
  proposeBillingAction: (
    input: McpBillingProposalInput,
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
  createIntakeNotesProposal: (
    input: McpIntakeNotesProposalInput,
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
        case 'torchiko.account.get_context': {
          const input = McpAccountContextInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'client-or-venue')
          result = await actions.accountContext(input, context)
          break
        }
        case 'torchiko.account.timeline': {
          const input = McpAccountHistoryInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'client-or-venue')
          result = await actions.accountTimeline(input, context)
          break
        }
        case 'torchiko.account.meetings': {
          const input = McpAccountHistoryInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'client-or-venue')
          result = await actions.accountMeetings(input, context)
          break
        }
        case 'torchiko.account.meeting_get': {
          const input = McpAccountMeetingGetInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'client-or-venue')
          result = await actions.accountMeetingGet(input, context)
          break
        }
        case 'torchiko.account.correspondence': {
          const input = McpAccountHistoryInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'client-or-venue')
          result = await actions.accountCorrespondence(input, context)
          break
        }
        case 'torchiko.meeting.process': {
          const input = McpMeetingProcessInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'venue')
          result = await actions.processMeeting(input, context)
          break
        }
        case 'torchiko.knowledge.search': {
          const input = McpKnowledgeSearchInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'client-or-venue')
          result = await actions.knowledgeSearch(input, context)
          break
        }
        case 'torchiko.knowledge.get': {
          const input = McpKnowledgeGetInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'client-or-venue')
          result = await actions.knowledgeGet(input, context)
          break
        }
        case 'torchiko.knowledge.list_gaps': {
          const input = McpKnowledgeGapListInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'venue')
          result = await actions.listKnowledgeGaps(input, context)
          break
        }
        case 'torchiko.knowledge.propose_correction': {
          const input = McpKnowledgeCorrectionProposalInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'venue')
          result = await actions.proposeKnowledgeCorrection(input, context)
          break
        }
        case 'torchiko.locations.propose_draft': {
          const input = McpLocationDraftProposalInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'venue')
          result = await actions.proposeLocationDraft(input, context)
          break
        }
        case 'torchiko.agent_improvements.propose': {
          const input = McpAgentImprovementProposalInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'venue')
          result = await actions.proposeAgentImprovement(input, context)
          break
        }
        case 'torchiko.agent_improvements.record_validation': {
          const input = McpAgentImprovementValidationInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'venue')
          result = await actions.recordAgentImprovementValidation(input, context)
          break
        }
        case 'torchiko.customer_access.prepare_invitation': {
          const input = McpCustomerAccessPreparationInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'venue')
          result = await actions.prepareCustomerAccessInvitation(input, context)
          break
        }
        case 'torchiko.integrations.health': {
          const input = McpIntegrationHealthInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'client-or-venue')
          result = await actions.integrationHealth(input, context)
          break
        }
        case 'torchiko.reports.get_lifecycle': {
          const input = McpReportLifecycleInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'venue')
          result = await actions.reportLifecycle(input, context)
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
        case 'pathfinder.propose_billing_action': {
          const input = McpBillingProposalInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'venue')
          result = await actions.proposeBillingAction(input, context)
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
        case 'pathfinder.create_intake_notes_proposal': {
          const input = McpIntakeNotesProposalInput.parse(arguments_)
          assertMcpScope(context.credential, input, metadata.capability, 'venue')
          await verifyApproval(
            actions,
            'pathfinder.create_intake_notes_proposal',
            input,
            metadata.capability,
            context,
          )
          result = await actions.createIntakeNotesProposal(input, context)
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
    | 'pathfinder.read'
    | 'torchiko.account.get_context'
    | 'torchiko.account.timeline'
    | 'torchiko.account.meetings'
    | 'torchiko.account.meeting_get'
    | 'torchiko.meeting.process'
    | 'torchiko.account.correspondence'
    | 'torchiko.knowledge.search'
    | 'torchiko.knowledge.get'
    | 'torchiko.knowledge.list_gaps'
    | 'torchiko.knowledge.propose_correction'
    | 'torchiko.locations.propose_draft'
    | 'torchiko.agent_improvements.propose'
    | 'torchiko.agent_improvements.record_validation'
    | 'torchiko.customer_access.prepare_invitation'
    | 'torchiko.integrations.health'
    | 'torchiko.reports.get_lifecycle'
    | 'pathfinder.ask_operator'
    | 'pathfinder.delegate_specialist'
    | 'pathfinder.propose_billing_action'
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
