import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('offboarding export finalization route boundary', () => {
  it('uses the safe server projection and fails controls closed', () => {
    expect(source).toContain('getCustomerStatePreservation')
    expect(source).toContain('<CustomerStatePreservationPanel')
    expect(source).toContain('getOffboardingExportFinalization')
    expect(source).toContain('Export artifact actions are unavailable for this plan.')
    expect(source).toContain('<OffboardingExportFinalizer')
  })

  it('does not render storage locators or hashes in plan history', () => {
    expect(source).not.toContain('artifact.artifactReference')
    expect(source).not.toContain('artifact.contentHash')
    expect(source).not.toContain('SHA-256')
    expect(source).not.toContain('evidence.evidenceReference')
    expect(source).not.toContain('evidence.errorCode')
    expect(source).not.toContain('label(evidence.outcome)')
    expect(source).toContain('revocationOutcome(evidence.outcome)')
    expect(source).toContain("return 'Outcome unavailable'")
    expect(source).toContain('stored {dateTime(artifact.createdAt)}')
  })
})
