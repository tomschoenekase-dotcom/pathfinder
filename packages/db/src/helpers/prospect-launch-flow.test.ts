import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { VenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset'
import { renderVenueQrSvg } from '@pathfinder/contracts/venue-qr-svg'
import { decodeSalesComponent, salesHash } from './prospect-sales-snapshot'
import { persistNativeSalesPreparation, reviewNativeSalesDraft } from './prospect-sales-actions'
import { importNativeWriterResult, readNativeWriterTask } from './prospect-sales-writer'
import { nativeMeaningBinding } from './prospect-sales-meaning'
import { requireCurrentProspectLaunchAttachments, prospectOperationalContentHash } from './prospect-launch-attachments'

const mock = vi.hoisted(() => ({ snapshot: vi.fn(), source: vi.fn() }))
vi.mock('./prospect-sales-snapshot', async (original) => ({
  ...(await original<typeof import('./prospect-sales-snapshot')>()), readNativeSalesSnapshot: mock.snapshot,
}))
vi.mock('./venue-launch-source', async (original) => ({
  ...(await original<typeof import('./venue-launch-source')>()), resolveVenueLaunchSource: mock.source,
}))

const publicUrl = 'https://example.com/chat?source=qr'
const bytes = Buffer.from(renderVenueQrSvg(publicUrl), 'utf8')
const asset: VenueLaunchAsset = {
  schema: 'torchiko.venue-launch-asset/1', tenantId: 'tenant', venueId: 'venue',
  release: { kind: 'NATIVE', id: 'release', revisionSha256: 'a'.repeat(64) },
  publicUrl, filename: 'venue-qr.svg',
  mimeType: 'image/svg+xml', sizeBytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64'),
}

describe('venue launch preparation to native writer boundary', () => {
  it('persists exact selected bytes and exports only a source-bound descriptor', async () => {
    mock.snapshot.mockResolvedValue({ venue: { id: 'prospect' }, organization: { id: 'org' },
      snapshotHash: 'b'.repeat(64), suppression: { blocked: false } })
    mock.source.mockResolvedValue({ tenantId: 'tenant', venueId: 'venue', venueName: 'Venue',
      publicUrl: asset.publicUrl, release: asset.release })
    let stored: Record<string, unknown> | null = null
    const drafts: Record<string, unknown>[] = []
    const activities = new Map<string, Record<string, unknown>>()
    const tx = {
      prospectLocationConversion: { findMany: vi.fn().mockResolvedValue([{ tenantId: 'tenant', venueId: 'venue' }]) },
      prospectContact: { findMany: vi.fn().mockResolvedValue([]) },
      prospectSourceEvidence: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
          stored?.id === where.id ? stored : null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          stored = data; return data
        }),
        findFirst: vi.fn(async () => stored),
      },
      prospectOutreachDraft: {
        findFirst: vi.fn(async () => drafts.at(-1) ?? null),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
          drafts.find((draft) => draft.id === where.id) ?? null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          drafts.push(data); return data
        }),
      },
      prospectActivity: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (typeof data.id === 'string') activities.set(data.id, data)
          return data
        }),
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
          activities.get(where.id) ?? null),
      },
    }
    const client = { ...tx, $transaction: vi.fn(async (work: (value: typeof tx) => unknown) => work(tx)) }
    const component = { schema: 'torchiko.native-sales-components/1',
      nativeSnapshotHash: 'b'.repeat(64), SEND_AUTHORIZED: false, senderAvailable: false,
      blocker: null, gate: { can_prepare: true }, componentCodeHashes: { owner: 'hash' },
      crosswalk: { nativeVenueId: 'prospect', nativeOrganizationId: 'org',
        routing: { kind: 'email', recipient: 'recipient@example.invalid', routing_id: 'route' } },
      preparation: { SEND_AUTHORIZED: false, metadata: { SEND_AUTHORIZED: false },
        request: { mode: 'cold' }, writerMarkdown: 'Write about the venue.',
        writerContext: { WLT_packet_identity: 'wlt', approved_language_snapshot: {} },
        fileSha256s: { context: 'c'.repeat(64) } },
    }
    const actor = { type: 'HUMAN' as const, role: 'PLATFORM_ADMIN' as const, id: 'operator' }
    await persistNativeSalesPreparation({ venueId: 'prospect', expectedSnapshotHash: 'b'.repeat(64),
      component, actor, launchAttachments: [asset] }, client as never)
    expect(stored).not.toBeNull()
    const persisted = decodeSalesComponent(stored!.capturedValue)
    expect(persisted.launchAttachments).toEqual([asset])
    const { task } = await readNativeWriterTask('prospect', component, client as never)
    expect(task.launchAttachments).toEqual([{ ...asset, contentBase64: undefined }].map(({ contentBase64: _bytes, ...descriptor }) => descriptor))
    expect(JSON.stringify(task)).not.toContain(asset.contentBase64)
    expect(task.binding.launchAttachmentsSha256).toMatch(/^[a-f0-9]{64}$/u)
    const subject = 'Venue visit'
    const body = 'Guests can open the venue QR.'
    const writerComponent = { ...component, draftCheck: {
      composerDraftSha256: createHash('sha256').update(`Subject: ${subject}\n\n${body}\n`).digest('hex'),
      bodySha256: createHash('sha256').update(body).digest('hex'), SEND_AUTHORIZED: false,
    } }
    const result = { schema: 'torchiko.native-writer-result/1' as const,
      taskId: task.taskId, binding: task.binding,
      generatedBy: { kind: 'model' as const, identity: 'Fixture writer' },
      subject, body, annotations: [], languageUses: [], assessment: null }
    const receipt = await importNativeWriterResult({ result, component: writerComponent,
      actor, assess: vi.fn() }, client as never)
    expect(receipt.evidence).toMatchObject({ generatedBy: result.generatedBy,
      humanApproval: 'ABSENT', SEND_AUTHORIZED: false })
    const draft = drafts[0]!
    expect(draft).toMatchObject({ subject, textBody: body, generatedByType: 'AGENT',
      generatedById: 'Fixture writer' })
    expect(draft.groundingSnapshot).toMatchObject({ launchAttachments: [asset],
      writerProvenance: { generatedBy: result.generatedBy } })
    const binding = nativeMeaningBinding(draft as never, persisted)
    expect(binding.bindingHash).toMatch(/^[a-f0-9]{64}$/u)
    const grounding = draft.groundingSnapshot as Record<string, unknown>
    const crosswalk = grounding.crosswalk as { routing: unknown }
    const legacyContentHash = salesHash({ series: draft.preparationKey,
      subject, body, preparationId: grounding.preparationId, route: crosswalk.routing,
      nativeSnapshotHash: grounding.nativeSnapshotHash })
    expect(legacyContentHash).not.toBe(draft.contentHash)
    expect(() => nativeMeaningBinding({ ...draft, contentHash: legacyContentHash } as never,
      persisted)).toThrow(/content\/recipient\/preparation binding/u)
    const changedIdentity = { ...asset, release: { ...asset.release, revisionSha256: 'e'.repeat(64) } }
    expect(() => nativeMeaningBinding(draft as never, { ...persisted,
      launchAttachments: [changedIdentity] })).toThrow(/LAUNCH_ASSET_SNAPSHOT_CHANGED/u)
    expect(() => nativeMeaningBinding({ ...draft, groundingSnapshot: { ...grounding,
      launchAttachments: [changedIdentity] } } as never, persisted))
      .toThrow(/LAUNCH_ASSET_SNAPSHOT_CHANGED/u)
    const reviewInput = { venueId: 'prospect', draftId: draft.id as string,
      contentHash: draft.contentHash as string, expectedSnapshotHash: 'b'.repeat(64), actor }
    mock.source.mockResolvedValueOnce({ tenantId: 'tenant', venueId: 'venue', venueName: 'Venue',
      publicUrl: asset.publicUrl, release: { ...asset.release, revisionSha256: 'd'.repeat(64) } })
    await expect(reviewNativeSalesDraft(reviewInput, client as never)).rejects.toThrow(/LAUNCH_ASSET_STALE/u)
    const review = await reviewNativeSalesDraft(reviewInput, client as never)
    expect(review.evidence).toMatchObject({ draftId: draft.id, contentHash: draft.contentHash,
      state: 'REVIEWED_NO_SEND', humanApproval: 'ABSENT', SEND_AUTHORIZED: false })
    await expect(reviewNativeSalesDraft({ ...reviewInput, contentHash: 'f'.repeat(64) },
      client as never)).rejects.toThrow(/exact native no-send revision/u)
    expect(prospectOperationalContentHash('to', 'Subject', 'Body', '', { launchAttachments: [asset] }))
      .not.toBe(prospectOperationalContentHash('to', 'Subject', 'Body', '', {}))
    await expect(requireCurrentProspectLaunchAttachments('wrong-prospect', [asset], {
      ...client, prospectLocationConversion: { findMany: vi.fn().mockResolvedValue([]) },
    } as never)).rejects.toThrow(/VENUE_MISMATCH/u)
    mock.source.mockResolvedValueOnce({ tenantId: 'tenant', venueId: 'venue', venueName: 'Venue',
      publicUrl: asset.publicUrl, release: { ...asset.release, revisionSha256: 'd'.repeat(64) } })
    await expect(requireCurrentProspectLaunchAttachments('prospect', [asset], client as never))
      .rejects.toThrow(/LAUNCH_ASSET_STALE/u)
    await expect(requireCurrentProspectLaunchAttachments('prospect', [{ ...asset,
      sha256: 'e'.repeat(64) }], client as never)).rejects.toThrow()
    const alternateBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    await expect(requireCurrentProspectLaunchAttachments('prospect', [{ ...asset,
      contentBase64: alternateBytes.toString('base64'), sizeBytes: alternateBytes.length,
      sha256: createHash('sha256').update(alternateBytes).digest('hex'),
    }], client as never)).rejects.toThrow(/LAUNCH_ASSET_BYTES_MISMATCH/u)
  })
})
