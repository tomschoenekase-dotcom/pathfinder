import { expect, it } from 'vitest'
import { OPERATOR_MCP_TOOLS } from '@pathfinder/contracts/operator-mcp'
import { createKindRegistry } from '../proposals'
import { OPERATOR_PROPOSAL_KINDS } from './index'

it('every registered proposal action uses the capability advertised by its public contract', () => {
  const kinds = createKindRegistry(OPERATOR_PROPOSAL_KINDS)
  for (const [tool, kind] of kinds) {
    const contract = OPERATOR_MCP_TOOLS.find((entry) => entry.name === tool)
    expect(contract, `${tool} must have a public contract`).toBeDefined()
    expect(kind.capability, `${tool} capability`).toBe(contract?.capability)
  }
})
