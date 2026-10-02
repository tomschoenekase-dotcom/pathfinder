import { describe, expect, it } from 'vitest'

import {
  ContentChangesetOps,
  VenueContentChangesetShape,
  VenuePreviewLinkInput,
  VenueReleasePreflightInput,
  VenueSourceGetInput,
} from './operator-venue-content'
import { OPERATOR_MCP_INPUTS, OPERATOR_MCP_OUTPUTS, OPERATOR_MCP_TOOLS } from './operator-mcp'

const scope = { tenantId: 't', venueId: 'v' }
const retire = {
  op: 'retire',
  representation: 'LEGACY_KNOWLEDGE',
  id: 'k1',
  expectedRevision: '2026-09-01T10:00:00.000Z',
}

describe('operator venue content contracts', () => {
  it('requires an expected revision on every update and retire, and none on a create', () => {
    expect(ContentChangesetOps.safeParse([retire]).success).toBe(true)
    const withoutRevision: Record<string, unknown> = { ...retire }
    delete withoutRevision.expectedRevision
    expect(ContentChangesetOps.safeParse([withoutRevision]).success).toBe(false)
    expect(
      ContentChangesetOps.safeParse([
        { op: 'create', representation: 'LEGACY_KNOWLEDGE', title: 'T', body: 'B' },
      ]).success,
    ).toBe(true)
    expect(
      ContentChangesetOps.safeParse([
        {
          op: 'create',
          representation: 'LEGACY_KNOWLEDGE',
          title: 'T',
          body: 'B',
          expectedRevision: '1',
        },
      ]).success,
    ).toBe(false)
  })

  it('cannot express an audience or visibility change on a legacy row', () => {
    for (const extra of [{ visibility: 'PUBLIC' }, { audience: 'PUBLIC' }, { isEnabled: true }]) {
      expect(
        ContentChangesetOps.safeParse([{ ...retire, op: 'update', body: 'x', ...extra }]).success,
      ).toBe(false)
    }
  })

  it('bounds the changeset and refuses two operations on one row', () => {
    const many = Array.from({ length: 26 }, (_, index) => ({ ...retire, id: `k${index}` }))
    expect(ContentChangesetOps.safeParse(many.slice(0, 25)).success).toBe(true)
    expect(ContentChangesetOps.safeParse(many).success).toBe(false)
    expect(ContentChangesetOps.safeParse([retire, { ...retire }]).success).toBe(false)
    // The same id in two different representations is two different rows.
    expect(
      ContentChangesetOps.safeParse([retire, { ...retire, representation: 'LEGACY_PLACE' }])
        .success,
    ).toBe(true)
  })

  it('validates typed drafts with the existing generalized payload rules', () => {
    const typed = {
      op: 'update',
      representation: 'TYPED_REVISION',
      id: 'm1',
      expectedRevision: '3',
      draft: {
        audience: 'PUBLIC',
        payload: {
          kind: 'EVENT',
          name: 'Open day',
          startsAt: '2026-10-10T10:00:00Z',
          endsAt: '2026-10-09T10:00:00Z',
        },
      },
    }
    expect(ContentChangesetOps.safeParse([typed]).success).toBe(false)
    expect(
      ContentChangesetOps.safeParse([
        {
          ...typed,
          draft: {
            ...typed.draft,
            payload: { ...typed.draft.payload, endsAt: '2026-10-10T12:00:00Z' },
          },
        },
      ]).success,
    ).toBe(true)
    // Evidence names a frozen source input, not a free-form claim.
    expect(
      ContentChangesetOps.safeParse([
        {
          ...retire,
          representation: 'TYPED_REVISION',
          effectiveUntil: '2026-10-10T10:00:00Z',
          evidence: [{ sourceId: 's', ordinal: -1 }],
        },
      ]).success,
    ).toBe(false)
  })

  it('keeps the new reads strict and the preflight target all-or-nothing', () => {
    expect(VenueSourceGetInput.safeParse({ ...scope, sourceId: 's', textOrdinal: 0 }).success).toBe(
      true,
    )
    expect(VenueSourceGetInput.safeParse({ ...scope, sourceId: 's', extra: 1 }).success).toBe(false)
    expect(VenueReleasePreflightInput.safeParse(scope).success).toBe(true)
    expect(
      VenueReleasePreflightInput.safeParse({ ...scope, releaseKind: 'NATIVE_RELEASE' }).success,
    ).toBe(false)
    expect(
      VenueReleasePreflightInput.safeParse({
        ...scope,
        releaseKind: 'NATIVE_RELEASE',
        releaseId: 'r',
      }).success,
    ).toBe(true)
    expect(
      VenuePreviewLinkInput.safeParse({ ...scope, releaseKind: 'PACKAGE_DRAFT', releaseId: 'p' })
        .success,
    ).toBe(true)
    expect(
      VenuePreviewLinkInput.safeParse({ ...scope, releaseKind: 'OTHER', releaseId: 'p' }).success,
    ).toBe(false)
    expect(Object.keys(VenueContentChangesetShape)).toEqual(['tenantId', 'venueId', 'ops'])
  })

  it('publishes every new tool in the catalog with the right effect and scope', () => {
    const reads = [
      'venues.list_sources',
      'venues.get_source',
      'venues.list_content',
      'venues.get_content',
      'venues.preview_content_changeset',
      'venues.list_releases',
      'venues.get_release',
      'venues.get_effective_guest_version',
      'venues.get_release_preflight',
      'venues.get_preview_link',
    ]
    for (const name of reads) {
      const tool = OPERATOR_MCP_TOOLS.find((entry) => entry.name === name)!
      expect(tool, name).toMatchObject({
        effect: 'read',
        capability: 'venues:read',
        scope: 'venue',
      })
      expect(OPERATOR_MCP_INPUTS[name as keyof typeof OPERATOR_MCP_INPUTS]).toBeDefined()
      expect(OPERATOR_MCP_OUTPUTS[name as keyof typeof OPERATOR_MCP_OUTPUTS]).toBeDefined()
    }
    expect(
      OPERATOR_MCP_TOOLS.find((entry) => entry.name === 'venues.propose_content_changeset'),
    ).toMatchObject({
      effect: 'proposal',
      capability: 'venues:propose',
      proposalKind: 'venues.content-changeset',
    })
    // There is no direct fetch, publish or preview-mutation tool.
    for (const forbidden of [
      'venues.fetch_source',
      'venues.publish_release',
      'venues.apply_release',
    ]) {
      expect(OPERATOR_MCP_TOOLS.some((entry) => entry.name === forbidden)).toBe(false)
    }
  })

  it('wraps retrieved source text and content as untrusted data', () => {
    const output = OPERATOR_MCP_OUTPUTS['venues.get_source']
    const base = {
      source: {
        sourceId: 's',
        venueId: 'v',
        url: 'https://example.com/',
        host: 'example.com',
        status: 'SUCCEEDED',
        note: null,
        maxPages: 5,
        maxBytesPerPage: 1000,
        parserVersion: 'v1',
        attempts: 1,
        errorCode: null,
        requestedAt: '2026-10-02T12:00:00.000Z',
        startedAt: null,
        completedAt: null,
        counts: { SUCCEEDED: 1, PARTIAL: 0, FAILED: 0, UNSUPPORTED: 0, SKIPPED: 0 },
      },
      inputs: [],
    }
    expect(
      output.safeParse({
        ...base,
        text: { ordinal: 0, content: { untrusted: true, text: 'x', truncated: false } },
      }).success,
    ).toBe(true)
    expect(output.safeParse({ ...base, text: { ordinal: 0, content: 'raw text' } }).success).toBe(
      false,
    )
  })
})
