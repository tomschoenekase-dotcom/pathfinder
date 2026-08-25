import { describe, expect, it } from 'vitest'

import { ReleaseEvidenceRecordPayload } from './release-evidence'

const assessment = {
  schemaVersion: 1 as const,
  generatedAt: '2026-08-25T04:01:22.858Z',
  revision: 'a'.repeat(40),
  profile: 'candidate' as const,
  readiness: 'ready-for-staging-review' as const,
  repository: { clean: true },
  summary: { passed: 2, failed: 0, blocked: 0 },
  gates: [
    { id: 'typecheck', status: 'pass' as const, durationMs: 100 },
    { id: 'visual-browser', status: 'pass' as const, durationMs: 200 },
  ],
  limitations: ['Hosted provider execution remains a separate evidence gate.'],
  rollback: {
    application: 'Redeploy the last admitted immutable staging revision.',
    database: 'Stop writers and repair forward.',
    runbook: 'docs/staging-release-workflow.md',
  },
}

const handoff = {
  artifactSha256: 'b'.repeat(64),
  status: 'ready-for-owner-staging-integration' as const,
  baseRevision: 'c'.repeat(40),
  baseIsAncestor: true,
  ahead: 4,
  behind: 0,
  changedFiles: 12,
  patchSha256: 'd'.repeat(64),
  migrationCount: 182,
  latestMigration: '20260825006000_add_platform_release_evidence',
  migrationChainSha256: 'e'.repeat(64),
  requiredActions: ['Integrate this exact candidate into staging.'],
  retainedGates: ['No production deployment is authorized.'],
}

describe('release evidence contracts', () => {
  it('accepts a bounded internally consistent assessment and staging handoff', () => {
    expect(
      ReleaseEvidenceRecordPayload.parse({
        operationId: '11111111-1111-4111-8111-111111111111',
        assessment,
        stagingHandoff: handoff,
        sourceReference: 'artifact://release/assessment.json',
      }),
    ).toMatchObject({ assessment: { summary: { passed: 2 } } })
  })

  it('rejects false-green summaries and staging handoffs', () => {
    expect(
      ReleaseEvidenceRecordPayload.safeParse({
        operationId: '11111111-1111-4111-8111-111111111111',
        assessment: { ...assessment, summary: { passed: 1, failed: 0, blocked: 0 } },
        stagingHandoff: handoff,
        sourceReference: 'artifact://release/assessment.json',
      }).success,
    ).toBe(false)

    expect(
      ReleaseEvidenceRecordPayload.safeParse({
        operationId: '11111111-1111-4111-8111-111111111111',
        assessment: { ...assessment, readiness: 'not-ready' },
        stagingHandoff: handoff,
        sourceReference: 'artifact://release/assessment.json',
      }).success,
    ).toBe(false)
  })
})
