import { z } from 'zod'

export const AgentIdentityType = z.enum([
  'PRIMARY',
  'INTAKE',
  'CONTENT',
  'MEDIA',
  'SUPPORT',
  'EVALUATION',
  'OPERATIONS',
])
export type AgentIdentityType = z.infer<typeof AgentIdentityType>

export const AgentAccessCapability = z.enum([
  'content.read',
  'content.draft',
  'content.apply-internal',
  'media.read',
  'intake.read',
  'support.read',
  'evaluation.read',
  'operations.read',
  'agents.read',
  'agents.delegate',
  'prospects.read',
  'prospects.draft',
  'prospects.question',
])
export type AgentAccessCapability = z.infer<typeof AgentAccessCapability>

export const AgentAutonomousAction = z.enum([
  'content.prepare-draft',
  'content.apply-internal-reversible',
  'agents.delegate-specialist',
])
export type AgentAutonomousAction = z.infer<typeof AgentAutonomousAction>

export const AgentConfigurationAccessScope = z.enum(['VENUE', 'CLIENT'])
export type AgentConfigurationAccessScope = z.infer<typeof AgentConfigurationAccessScope>

export const AgentConfigurationAutonomyLevel = z.enum([
  'READ_ONLY',
  'DRAFT',
  'INTERNAL_REVERSIBLE',
  'BROAD_AUTONOMOUS',
])
export type AgentConfigurationAutonomyLevel = z.infer<typeof AgentConfigurationAutonomyLevel>

export const AgentExecutionProvider = z.enum([
  'anthropic',
  'hermes-bridge',
  'claude-bridge',
  'codex-bridge',
  'openai-compatible-bridge',
])
export type AgentExecutionProvider = z.infer<typeof AgentExecutionProvider>

/**
 * The capability required to stage each autonomous action. This mapping is
 * intentionally closed: adding an action requires a reviewed contract change.
 */
export const AGENT_ACTION_CAPABILITY = {
  'content.prepare-draft': 'content.draft',
  'content.apply-internal-reversible': 'content.apply-internal',
  'agents.delegate-specialist': 'agents.delegate',
} as const satisfies Record<AgentAutonomousAction, AgentAccessCapability>

export const AgentIdentityConfigurationFields = z
  .object({
    identityKey: z
      .string()
      .trim()
      .min(3)
      .max(100)
      .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
    name: z.string().trim().min(1).max(191),
    description: z.string().trim().max(2_000).nullable(),
    agentType: AgentIdentityType,
    accessCapabilities: z.array(AgentAccessCapability).max(AgentAccessCapability.options.length),
    autonomyLevel: AgentConfigurationAutonomyLevel,
    autonomousActions: z.array(AgentAutonomousAction).max(AgentAutonomousAction.options.length),
    defaultProvider: AgentExecutionProvider.nullable().optional(),
    defaultModel: z.string().trim().min(1).max(191).nullable().optional(),
  })
  .strict()

export type AgentIdentityConfigurationFields = z.input<typeof AgentIdentityConfigurationFields>

export function agentConfigurationCoherenceIssue(
  fields: Pick<
    AgentIdentityConfigurationFields,
    'accessCapabilities' | 'autonomyLevel' | 'autonomousActions'
  > &
    Partial<Pick<AgentIdentityConfigurationFields, 'defaultProvider' | 'defaultModel'>>,
): string | null {
  const capabilities = new Set(fields.accessCapabilities)
  const actions = new Set(fields.autonomousActions)
  if (capabilities.size !== fields.accessCapabilities.length) {
    return 'Access capabilities must not contain duplicates'
  }
  if (actions.size !== fields.autonomousActions.length) {
    return 'Autonomous actions must not contain duplicates'
  }
  if (fields.autonomyLevel === 'READ_ONLY' && actions.size > 0) {
    return 'Read-only identities cannot have autonomous actions'
  }
  if (
    fields.autonomyLevel === 'DRAFT' &&
    [...actions].some((action) => action !== 'content.prepare-draft')
  ) {
    return 'Draft identities may only prepare drafts autonomously'
  }
  for (const action of actions) {
    if (!capabilities.has(AGENT_ACTION_CAPABILITY[action])) {
      return `Autonomous action ${action} requires capability ${AGENT_ACTION_CAPABILITY[action]}`
    }
  }
  const hasProvider = (fields.defaultProvider ?? null) !== null
  const hasModel = (fields.defaultModel ?? null) !== null
  if (hasProvider !== hasModel) {
    return 'Execution provider and model must be configured together'
  }
  if (fields.defaultProvider === 'anthropic' && fields.defaultModel !== 'claude-sonnet-4-6') {
    return 'Anthropic specialists currently require claude-sonnet-4-6'
  }
  return null
}
