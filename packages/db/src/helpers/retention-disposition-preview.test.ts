import { RetentionDecisionKey } from '@pathfinder/contracts'
import { describe, expect, it, vi } from 'vitest'

import { PLATFORM_TABLES, SHARED_SCOPE_TABLES, TENANTED_TABLES } from '../tenanted-tables'
import {
  previewRetentionDispositionAction,
  type RetentionDispositionPreviewClient,
} from './retention-disposition-preview'

function delegateName(model: string): string {
  return `${model.slice(0, 1).toLowerCase()}${model.slice(1)}`
}

function client(options: { tenantExists?: boolean; unavailableModel?: string } = {}) {
  const value: Record<string, unknown> = {
    tenant: {
      findUnique: vi.fn(async () => (options.tenantExists === false ? null : { id: 'tenant-1' })),
    },
  }
  ;[...TENANTED_TABLES, ...SHARED_SCOPE_TABLES].forEach((model, index) => {
    if (model === options.unavailableModel) return
    value[delegateName(model)] = {
      count: vi.fn(async () => index + 1),
    }
  })
  return value as RetentionDispositionPreviewClient
}

describe('retention disposition preview', () => {
  it('counts every directly tenant-linked model and exposes every unresolved boundary', async () => {
    const db = client()
    const preview = await previewRetentionDispositionAction(
      {
        tenantId: 'tenant-1',
        generatedAt: new Date('2026-08-25T02:00:00.000Z'),
        countBatchSize: 7,
      },
      db,
    )

    expect(preview).toMatchObject({
      schemaVersion: 'torchiko-retention-disposition-preview-v1',
      generatedAt: '2026-08-25T02:00:00.000Z',
      scope: { tenantId: 'tenant-1', venueIds: null, fullTenantOnly: true },
      mode: 'READ_ONLY_NO_EFFECT',
      tenantExists: true,
      policy: {
        ready: false,
        policyVersion: null,
        unresolvedDecisionKeys: RetentionDecisionKey.options,
      },
      boundaries: {
        readyForExecution: false,
        destructiveActionAvailable: false,
        anonymizationActionAvailable: false,
        approvalGrantAvailable: false,
        externalArtifactsCounted: false,
        providerRecordsCounted: false,
        backupRestoreTreatmentResolved: false,
      },
    })
    expect(preview.inventory.map((item) => item.model)).toEqual([
      'Tenant',
      ...TENANTED_TABLES,
      ...SHARED_SCOPE_TABLES,
      ...PLATFORM_TABLES.filter((model) => model !== 'Tenant'),
    ])
    expect(preview.coverage.exactCountedModels).toBe(
      1 + TENANTED_TABLES.length + SHARED_SCOPE_TABLES.length,
    )
    expect(preview.coverage.unavailableCountModels).toBe(0)
    expect(preview.coverage.platformUnscopedModels).toBe(PLATFORM_TABLES.length - 1)
    expect(preview.coverage.tenantLinkedUnclassifiedModels).toBeGreaterThan(0)
    expect(preview.blockers).toEqual([
      'UNRESOLVED_POLICY',
      'UNCLASSIFIED_TENANT_DATA',
      'PLATFORM_UNSCOPED_DATA',
      'EXTERNAL_ARTIFACTS_NOT_COUNTED',
      'NO_REVIEWED_EXECUTOR',
    ])
    expect(preview.inventory.find((item) => item.model === 'ProspectEmailMessage')).toMatchObject({
      scopeClass: 'PLATFORM_UNSCOPED',
      countState: 'UNSCOPED',
      rowCount: null,
      decisionKey: 'content-history-and-provenance',
    })
    expect(preview.inventory.find((item) => item.model === 'GuestChatTurn')).toMatchObject({
      scopeClass: 'TENANT_DIRECT',
      countState: 'EXACT',
      decisionKey: null,
    })
    for (const model of [...TENANTED_TABLES, ...SHARED_SCOPE_TABLES]) {
      expect(
        (db[delegateName(model)] as { count: ReturnType<typeof vi.fn> }).count,
      ).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1' } })
    }
  })

  it('fails the preview closed when even one tenant-linked count is unavailable', async () => {
    const preview = await previewRetentionDispositionAction(
      { tenantId: 'tenant-1', generatedAt: new Date('2026-08-25T02:00:00.000Z') },
      client({ unavailableModel: 'GuestChatTurn' }),
    )
    expect(preview.coverage.unavailableCountModels).toBe(1)
    expect(preview.blockers).toContain('COUNT_UNAVAILABLE')
    expect(preview.inventory.find((item) => item.model === 'GuestChatTurn')).toMatchObject({
      countState: 'UNAVAILABLE',
      rowCount: null,
    })
  })

  it('returns exact zero tenant-linked counts without querying orphan data for a missing tenant', async () => {
    const db = client({ tenantExists: false })
    const preview = await previewRetentionDispositionAction(
      { tenantId: 'missing-tenant', generatedAt: new Date('2026-08-25T02:00:00.000Z') },
      db,
    )
    expect(preview.tenantExists).toBe(false)
    expect(preview.blockers[0]).toBe('TENANT_NOT_FOUND')
    expect(preview.coverage.exactTenantLinkedRows).toBe('0')
    for (const model of [...TENANTED_TABLES, ...SHARED_SCOPE_TABLES]) {
      expect(
        (db[delegateName(model)] as { count: ReturnType<typeof vi.fn> }).count,
      ).not.toHaveBeenCalled()
    }
  })
})
