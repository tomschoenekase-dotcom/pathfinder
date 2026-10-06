import { resolveReleaseRevision } from '@pathfinder/config/release-identity'
import {
  OPERATOR_MCP_CATALOG_VERSION,
  OPERATOR_MCP_INPUTS,
  OPERATOR_MCP_TOOLS,
} from '@pathfinder/contracts/operator-mcp'

import { isAlwaysAskKind, operatorApprovalMode, readAutonomyPolicies } from '../autonomy'
import { customerDeploymentPrerequisite } from '../deployment-prerequisite'
import type { OperatorReadTool } from '../registry'
import { OPERATOR_MANUAL_VERSION } from './manual-text'

const MAX_TENANT_IDS = 100

/**
 * `operator.get_context`: what this connection can actually reach. The tool list covers every
 * declared tool, so a declared-but-unbuilt tool reads `implemented: false` instead of vanishing.
 * Provider and worker health are reported as null (not measured) rather than guessed.
 */
export function createContextReadTool(implemented: ReadonlySet<string>): OperatorReadTool {
  return {
    name: 'operator.get_context',
    capability: 'operator:read',
    async handler(raw, context) {
      OPERATOR_MCP_INPUTS['operator.get_context'].parse(raw)
      const grant = context.grant
      const [policies, successes] = await Promise.all([
        readAutonomyPolicies(context.database),
        context.database.operatorAuditEvent.groupBy({
          by: ['tool'],
          where: {
            grantId: grant.grantId,
            eventType: 'mcp.call',
            outcome: { startsWith: 'OK' },
          },
          _max: { occurredAt: true },
        }),
      ])
      const autoKinds = new Map(policies.map((policy) => [policy.capability, policy.autoKinds]))
      const lastSuccess = new Map(successes.map((row) => [row.tool, row._max.occurredAt] as const))
      const capabilities = new Set<string>(grant.capabilities)
      const missing = [...new Set(OPERATOR_MCP_TOOLS.map((tool) => tool.capability))].filter(
        (capability) => !capabilities.has(capability),
      )
      const scopeNotes = [
        'crm.* tools read the platform-wide CRM. A tenant-limited connection does not narrow them.',
        grant.allTenants
          ? 'Customer, venue and support tools can reach every tenant. Use customers.list for tenantIds.'
          : `Customer, venue and support tools are limited to ${grant.tenantIds.length} tenant(s). Use customers.list for tenantIds.`,
        'A tool being listed here does not prove its provider, worker or release gate is live.',
        'implemented means registered; authorized means capability granted. Customer creation also requires allTenants and its deploymentPrerequisite. Plans check each step before recording and retain required approvals.',
        ...(missing.length > 0 ? [missingCapabilitiesNote(missing)] : []),
      ]
      return {
        serverTime: context.now.toISOString(),
        catalogVersion: OPERATOR_MCP_CATALOG_VERSION,
        manualVersion: OPERATOR_MANUAL_VERSION,
        releaseRevision: resolveReleaseRevision(process.env),
        grant: {
          grantId: grant.grantId,
          allTenants: grant.allTenants,
          tenantCount: grant.tenantIds.length,
          tenantIds: grant.tenantIds.slice(0, MAX_TENANT_IDS),
          capabilities: [...grant.capabilities],
        },
        scopeNotes,
        tools: OPERATOR_MCP_TOOLS.map((tool) => {
          const isImplemented = implemented.has(tool.name)
          const proposal = tool.effect === 'proposal'
          const approvalMode =
            !proposal || !isImplemented
              ? null
              : // With no approval step every write, plans included, applies when called.
                operatorApprovalMode() === 'none'
                ? ('auto' as const)
                : tool.proposalKind && isAlwaysAskKind(tool.proposalKind)
                  ? ('ask' as const)
                  : autoKinds.get(tool.capability)?.includes(tool.proposalKind ?? '')
                    ? ('auto' as const)
                    : ('ask' as const)
          return {
            name: tool.name,
            effect: tool.effect,
            scope: tool.scope,
            capability: tool.capability,
            implemented: isImplemented,
            authorized: capabilities.has(tool.capability),
            approvalMode,
            lastSuccessAt: lastSuccess.get(tool.name)?.toISOString() ?? null,
            deploymentPrerequisite: customerDeploymentPrerequisite(tool.name),
            providerConnected: null,
            workerAvailable: null,
          }
        }),
      }
    },
  }
}

/** The published scope note is at most 300 characters; name what fits and count the rest. */
export function missingCapabilitiesNote(missing: readonly string[], limit = 300): string {
  const sorted = [...missing].sort()
  const prefix = 'This connection lacks capabilities: '
  for (let shown = sorted.length; shown > 0; shown -= 1) {
    const rest = sorted.length - shown
    const note = `${prefix}${sorted.slice(0, shown).join(', ')}${rest > 0 ? ` and ${rest} more` : ''}.`
    if (note.length <= limit) return note
  }
  return `This connection lacks ${sorted.length} capabilities.`
}
