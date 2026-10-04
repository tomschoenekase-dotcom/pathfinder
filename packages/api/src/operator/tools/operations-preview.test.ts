import { describe, expect, it } from 'vitest'
import { previewDigestOf, type AnyOperatorProposalKind } from '../proposals'
import type { OperatorCallContext } from '../registry'
import { proposalOperationView } from './operations'

const kind = {
  tool: 'crm.propose_import_commit',
  parse: (value: unknown) => value,
  describe: () => ({
    title: 'Commit the reviewed import',
    lines: ['13 rows; 7 skipped', 'File and mapping hashes are bound'],
  }),
} as unknown as AnyOperatorProposalKind
const context = {
  config: { issuer: 'https://operator.example' },
  now: new Date(),
  kinds: new Map([[kind.tool, kind]]),
} as unknown as OperatorCallContext
const row = {
  id: 'proposal-1',
  status: 'PENDING',
  tool: kind.tool,
  kind: 'crm.import-commit',
  args: {},
  targetVersion: 'v1',
  previewDigest: previewDigestOf(kind, {}, 'v1'),
  planId: null,
  createdAt: new Date(),
  expiresAt: new Date(),
  decidedAt: null,
  appliedAt: null,
  applyClaimedAt: null,
  leaseExpiresAt: null,
  attempt: 0,
} as Parameters<typeof proposalOperationView>[0]
describe('chat proposal preview', () => {
  it('shows the same description bound to approval and the next decision action', () => {
    const result = proposalOperationView(row, context)
    expect(result.preview).toMatchObject({
      ...kind.describe({}),
      matchesCurrentDefinition: true,
      targetVersion: 'v1',
    })
    expect(result.nextAction).toContain('operator.request_decision')
  })
  it('marks an obsolete preview and keeps unreadable historical proposals inspectable', () => {
    expect(
      proposalOperationView({ ...row, previewDigest: 'a'.repeat(64) }, context).preview
        ?.matchesCurrentDefinition,
    ).toBe(false)
    expect(proposalOperationView(row, { ...context, kinds: new Map() }).preview).toBeNull()
  })
})
