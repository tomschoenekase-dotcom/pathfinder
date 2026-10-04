import { describe, expect, it, vi } from 'vitest'

import { GmailApiError, type GmailCredentialLeaseProvider } from './gmail'
import {
  createGmailDraftReader,
  reconcileGmailProviderDrafts,
  type GmailApiDraftRef,
  type GmailDraftApiClient,
  type ProviderDraftReferenceStore,
} from './gmail-drafts'
import { createGmailApiClient } from './gmail-http-client'
import { CorrespondenceProviderError, type ProviderMailboxRef } from './types'

const mailbox: ProviderMailboxRef = {
  provider: 'GMAIL',
  providerAccountId: 'account-1',
  mailboxId: 'mailbox-1',
  mailboxAddress: 'outreach@torchiko.test',
  credentialRef: 'credential-ref-1',
}

const credentials: GmailCredentialLeaseProvider = {
  lease: vi.fn(async () => ({
    withAccessToken: async <T>(callback: (token: string) => Promise<T>) => callback('short-lived'),
  })),
}

/** Fixture provider mailbox: pages of draft resources plus the set that still exists. */
function fakeDraftClient(input: {
  pages: readonly (readonly GmailApiDraftRef[])[]
  existing?: readonly string[]
  getFailure?: GmailApiError
}) {
  const existing = new Set(input.existing ?? input.pages.flat().map((draft) => draft.id))
  const client: GmailDraftApiClient = {
    listDrafts: vi.fn(async ({ pageToken }) => {
      const index = pageToken ? Number(pageToken.replace('page-', '')) : 0
      const next = index + 1 < input.pages.length ? `page-${index + 1}` : undefined
      return { drafts: input.pages[index] ?? [], ...(next ? { nextPageToken: next } : {}) }
    }),
    getDraft: vi.fn(async ({ draftId }) => {
      if (input.getFailure) throw input.getFailure
      if (!existing.has(draftId)) throw new GmailApiError('NOT_FOUND', 'missing')
      return {
        id: draftId,
        messageId: `m-${draftId}`,
        threadId: `t-${draftId}`,
        labelIds: ['DRAFT'],
      }
    }),
  }
  return client
}

function fakeStore(references: readonly { localDraftId: string; providerDraftId: string }[]) {
  const live = new Map(references.map((item) => [item.localDraftId, item.providerDraftId]))
  const released: unknown[] = []
  const store: ProviderDraftReferenceStore = {
    listReferencedDrafts: vi.fn(async ({ limit }) =>
      [...live].slice(0, limit).map(([localDraftId, providerDraftId]) => ({
        localDraftId,
        providerDraftId,
      })),
    ),
    releaseAbsentReference: vi.fn(async (value) => {
      if (live.get(value.localDraftId) !== value.providerDraftId) return false
      live.delete(value.localDraftId)
      released.push(value)
      return true
    }),
  }
  return { store, released, live }
}

const draft = (id: string): GmailApiDraftRef => ({ id, messageId: `m-${id}`, threadId: `t-${id}` })
const observedAt = new Date('2026-10-02T12:00:00.000Z')

describe('native Gmail draft reconciliation', () => {
  it('keeps present references, releases only provider-confirmed absences and links nothing by guess', async () => {
    const client = fakeDraftClient({
      pages: [[draft('r-present'), draft('r-unreferenced')], [draft('r-second-page')]],
      existing: ['r-present', 'r-unreferenced', 'r-second-page'],
    })
    const fixture = fakeStore([
      { localDraftId: 'local-present', providerDraftId: 'r-present' },
      { localDraftId: 'local-second-page', providerDraftId: 'r-second-page' },
      { localDraftId: 'local-gone', providerDraftId: 'r-gone' },
    ])

    const result = await reconcileGmailProviderDrafts({
      mailbox,
      reader: createGmailDraftReader({ credentials, client }),
      store: fixture.store,
      now: () => observedAt,
    })

    expect(result).toEqual({
      complete: true,
      providerDraftsSeen: 3,
      referencedLocalDrafts: 3,
      referencesConfirmedPresent: 2,
      referencesReleasedAsAbsent: 1,
      unreferencedProviderDrafts: 1,
    })
    expect(fixture.released).toEqual([
      {
        providerAccountId: 'account-1',
        localDraftId: 'local-gone',
        providerDraftId: 'r-gone',
        observedAt,
      },
    ])
    expect(client.getDraft).toHaveBeenCalledTimes(1)
  })

  it('does not release a reference that the listing omitted but drafts.get still finds', async () => {
    const client = fakeDraftClient({ pages: [[]], existing: ['r-lagging'] })
    const fixture = fakeStore([{ localDraftId: 'local-1', providerDraftId: 'r-lagging' }])
    const result = await reconcileGmailProviderDrafts({
      mailbox,
      reader: createGmailDraftReader({ credentials, client }),
      store: fixture.store,
    })
    expect(result.referencesConfirmedPresent).toBe(1)
    expect(fixture.released).toEqual([])
  })

  it('concludes nothing about absence when the listing exceeds its page budget', async () => {
    const client = fakeDraftClient({
      pages: [[draft('r-1')], [draft('r-2')], [draft('r-3')]],
      existing: [],
    })
    const fixture = fakeStore([{ localDraftId: 'local-1', providerDraftId: 'r-9' }])
    const result = await reconcileGmailProviderDrafts({
      mailbox,
      reader: createGmailDraftReader({ credentials, client }),
      store: fixture.store,
      maxPages: 2,
    })
    expect(result.complete).toBe(false)
    expect(client.listDrafts).toHaveBeenCalledTimes(2)
    expect(client.getDraft).not.toHaveBeenCalled()
    expect(fixture.released).toEqual([])
  })

  it('surfaces provider failures without releasing anything', async () => {
    const client = fakeDraftClient({
      pages: [[]],
      getFailure: new GmailApiError('RATE_LIMIT', 'slow down', 'NOT_ACCEPTED', 1_000),
    })
    const fixture = fakeStore([{ localDraftId: 'local-1', providerDraftId: 'r-1' }])
    await expect(
      reconcileGmailProviderDrafts({
        mailbox,
        reader: createGmailDraftReader({ credentials, client }),
        store: fixture.store,
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' } satisfies Partial<CorrespondenceProviderError>)
    expect(fixture.released).toEqual([])
  })

  it('counts a concurrently changed reference as not released', async () => {
    const client = fakeDraftClient({ pages: [[]], existing: [] })
    const fixture = fakeStore([{ localDraftId: 'local-1', providerDraftId: 'r-1' }])
    vi.mocked(fixture.store.releaseAbsentReference).mockResolvedValueOnce(false)
    const result = await reconcileGmailProviderDrafts({
      mailbox,
      reader: createGmailDraftReader({ credentials, client }),
      store: fixture.store,
    })
    expect(result.referencesReleasedAsAbsent).toBe(0)
  })

  it('rejects non-Gmail mailboxes and unbounded budgets before provider access', async () => {
    const client = fakeDraftClient({ pages: [[]] })
    const reader = createGmailDraftReader({ credentials, client })
    await expect(
      reconcileGmailProviderDrafts({
        mailbox,
        reader,
        store: fakeStore([]).store,
        maxPages: 50,
      }),
    ).rejects.toThrow('page budget')
    await expect(
      reader.listPage({ ...mailbox, provider: 'FAKE' }, { pageSize: 10 }),
    ).rejects.toThrow()
    expect(client.listDrafts).not.toHaveBeenCalled()
  })

  it('runs end to end over the HTTP client with an injected transport and no live calls', async () => {
    const urls: string[] = []
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      urls.push(url)
      const body = url.includes('/drafts?')
        ? { drafts: [{ id: 'r-1', message: { id: 'dm-1', threadId: 'dt-1' } }] }
        : null
      return body
        ? new Response(JSON.stringify(body), { status: 200 })
        : new Response(null, { status: 404 })
    })
    const fixture = fakeStore([
      { localDraftId: 'local-1', providerDraftId: 'r-1' },
      { localDraftId: 'local-2', providerDraftId: 'r-2' },
    ])
    const result = await reconcileGmailProviderDrafts({
      mailbox,
      reader: createGmailDraftReader({
        credentials,
        client: createGmailApiClient({ fetch: transport, apiBaseUrl: 'https://gmail.test/v1' }),
      }),
      store: fixture.store,
    })
    expect(result).toMatchObject({ referencesConfirmedPresent: 1, referencesReleasedAsAbsent: 1 })
    expect(urls.every((url) => url.startsWith('https://gmail.test/v1/'))).toBe(true)
    expect(fixture.live.get('local-1')).toBe('r-1')
  })
})
