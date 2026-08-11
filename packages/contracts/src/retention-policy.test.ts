import { describe, expect, it } from 'vitest'

import {
  assessRetentionReadiness,
  assertRetentionExecutionAuthorized,
  RETENTION_DATA_INVENTORY,
  RetentionDecisionKey,
  RetentionPolicySet,
} from './retention-policy'

describe('retention policy architecture', () => {
  it('keeps inventory models unique and every entry mapped to an explicit owner decision', () => {
    const models = RETENTION_DATA_INVENTORY.map((entry) => entry.model)
    expect(new Set(models).size).toBe(models.length)
    for (const entry of RETENTION_DATA_INVENTORY) {
      expect(RetentionDecisionKey.options).toContain(entry.decisionKey)
      expect(entry.notes.length).toBeGreaterThan(10)
    }
  })

  it('fails closed when no legal policy has been supplied', () => {
    expect(assessRetentionReadiness(null)).toEqual({
      ready: false,
      unresolvedDecisionKeys: RetentionDecisionKey.options,
      policyVersion: null,
    })
    expect(() => assertRetentionExecutionAuthorized(null)).toThrow('Retention execution is blocked')
  })

  it('rejects duplicate, mismatched, or duration-free destructive decisions', () => {
    const duplicate = {
      policyVersion: 'owner-policy-v1',
      decisions: [
        {
          decisionKey: 'guest-conversations',
          action: 'DELETE',
          retentionDays: 30,
          rationale: 'Owner-approved fixture only',
          approvedBy: 'owner-fixture',
          approvedAt: '2026-08-11T12:00:00.000Z',
          policyVersion: 'owner-policy-v1',
        },
        {
          decisionKey: 'guest-conversations',
          action: 'DELETE',
          retentionDays: null,
          rationale: 'Duplicate fixture',
          approvedBy: 'owner-fixture',
          approvedAt: '2026-08-11T12:00:00.000Z',
          policyVersion: 'wrong-version',
        },
      ],
    }
    expect(RetentionPolicySet.safeParse(duplicate).success).toBe(false)
  })

  it('reports the exact unresolved decisions without enabling execution', () => {
    const partial = RetentionPolicySet.parse({
      policyVersion: 'fixture-v1',
      decisions: [
        {
          decisionKey: 'guest-conversations',
          action: 'ANONYMIZE',
          retentionDays: 90,
          rationale: 'Non-production policy fixture',
          approvedBy: 'fixture-owner',
          approvedAt: '2026-08-11T12:00:00.000Z',
          policyVersion: 'fixture-v1',
        },
      ],
    })
    const readiness = assessRetentionReadiness(partial)
    expect(readiness.ready).toBe(false)
    expect(readiness.unresolvedDecisionKeys).not.toContain('guest-conversations')
    expect(readiness.unresolvedDecisionKeys).toHaveLength(RetentionDecisionKey.options.length - 1)
  })
})
