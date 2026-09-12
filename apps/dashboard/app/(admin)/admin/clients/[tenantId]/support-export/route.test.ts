import { createHash } from 'node:crypto'

import {
  canonicalSupportPortableExportJson,
  SUPPORT_PORTABLE_EXPORT_MAX_BYTES,
  SupportPortableExportPayload,
} from '@pathfinder/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const prepareSupportPortableExport = vi.hoisted(() => vi.fn())
vi.mock('../../../../../../lib/admin-caller', () => ({
  createAdminCaller: async () => ({ admin: { prepareSupportPortableExport } }),
}))

import { POST } from './route'

const iso = '2026-09-12T00:00:00.000Z'

function envelope(description: string | null = null) {
  const payload = SupportPortableExportPayload.parse({
    schemaVersion: 'support-portable-export-v1',
    capturedAt: iso,
    scope: { tenantId: 'tenant-a', venueId: 'venue-a', recipientUserId: 'user-a' },
    recipient: { role: 'OWNER' },
    sections: ['current-venue'],
    counts: {
      places: 0,
      knowledgeEntries: 0,
      contentHistoryVersions: 0,
      venuePackages: 0,
      publishedReports: 0,
      supportRequests: 0,
      supportMessages: 0,
      supportAttachments: 0,
    },
    omissions: [
      'guest-conversations-and-location',
      'voice-and-provider-sessions',
      'internal-support-and-audit-evidence',
      'credentials-asset-urls-and-private-storage-locators',
      'intake-originals-quarantine-and-media-bytes',
      'billing-provider-and-raw-analytics-records',
      'native-release-artifacts-and-asset-downloads',
      'account-wide-and-offboarding-material',
    ],
    currentVenue: {
      venue: {
        id: 'venue-a',
        name: 'Riverside Aquarium',
        slug: 'riverside-aquarium',
        description,
        guideNotes: null,
        aiGuideNotes: null,
        aiFeaturedPlaceId: null,
        aiTone: null,
        tonePreset: null,
        tonePresetVersion: null,
        aiGuideName: null,
        chatTheme: null,
        chatAccentColor: null,
        chatFont: null,
        chatShowPhotos: true,
        chatShowLinks: true,
        category: null,
        guideMode: 'DEFAULT',
        defaultCenterLat: null,
        defaultCenterLng: null,
        isActive: true,
        createdAt: iso,
        updatedAt: iso,
      },
      botConfiguration: null,
      places: [],
      knowledgeEntries: [],
    },
  })
  return {
    ...payload,
    contentSha256: createHash('sha256')
      .update(canonicalSupportPortableExportJson(payload), 'utf8')
      .digest('hex'),
  }
}

function request(body: unknown, options: { origin?: string; contentType?: string } = {}) {
  return new Request('https://dashboard.test/admin/clients/tenant-a/support-export', {
    method: 'POST',
    headers: {
      Origin: options.origin ?? 'https://dashboard.test',
      'Content-Type': options.contentType ?? 'application/json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const input = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  recipientUserId: 'user-a',
  sections: ['current-venue'],
}
const context = { params: Promise.resolve({ tenantId: 'tenant-a' }) }

describe('support portable export download route', () => {
  beforeEach(() => prepareSupportPortableExport.mockReset())

  it('returns only verified canonical bytes with private download headers', async () => {
    const value = envelope()
    prepareSupportPortableExport.mockResolvedValue(value)
    const response = await POST(request(input), context)
    const expected = canonicalSupportPortableExportJson(value)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="support-portable-export.json"',
    )
    expect(await response.text()).toBe(expected)
    expect(prepareSupportPortableExport).toHaveBeenCalledWith(input)
  })

  it.each([
    ['missing origin', request(input, { origin: '' }), 403],
    ['cross-site origin', request(input, { origin: 'https://attacker.test' }), 403],
    ['wrong content type', request(input, { contentType: 'text/plain' }), 415],
    ['path and body tenant mismatch', request({ ...input, tenantId: 'tenant-b' }), 400],
    ['malformed body', request('{'), 400],
    ['oversized body', request('x'.repeat(17 * 1024)), 400],
  ])('rejects %s before calling the export reader', async (_label, value, status) => {
    const response = await POST(value, context)
    expect(response.status).toBe(status)
    expect(prepareSupportPortableExport).not.toHaveBeenCalled()
  })

  it('fails closed for an invalid checksum and a final response over 10 MiB', async () => {
    prepareSupportPortableExport.mockResolvedValue({ ...envelope(), contentSha256: '0'.repeat(64) })
    expect((await POST(request(input), context)).status).toBe(500)

    prepareSupportPortableExport.mockResolvedValue(envelope('x'.repeat(SUPPORT_PORTABLE_EXPORT_MAX_BYTES)))
    expect((await POST(request(input), context)).status).toBe(413)
  })

})
