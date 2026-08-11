import { describe, expect, it } from 'vitest'

import {
  OffboardingExportManifestPreview,
  OffboardingExportPreviewInput,
} from './offboarding-export-preview'

describe('offboarding export preview contract', () => {
  it('requires unique bounded venue selection', () => {
    expect(
      OffboardingExportPreviewInput.safeParse({ tenantId: 't1', venueIds: ['v1', 'v1'] }).success,
    ).toBe(false)
    expect(OffboardingExportPreviewInput.safeParse({ tenantId: 't1', venueIds: [] }).success).toBe(
      false,
    )
  })

  it('rejects raw or private payload fields', () => {
    const result = OffboardingExportManifestPreview.safeParse({
      schemaVersion: 1,
      generatedAt: '2030-01-01T00:00:00.000Z',
      tenantId: 't1',
      selectedVenueIds: ['v1'],
      privacyBoundary: 'METADATA_REFERENCES_ONLY',
      venues: [],
      currentContent: [],
      contentHistory: [],
      packages: [],
      modules: [],
      revisions: [],
      evidence: [],
      truncation: {},
      supportMessages: [{ body: 'private' }],
    })
    expect(result.success).toBe(false)
  })
})
