import { randomBytes, randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { reconcileGmailProviderDrafts, type ProviderDraftReader } from './gmail-drafts'
import { createPrismaProviderDraftReferenceStore } from './prisma-provider-draft-store'
import type { ProviderMailboxRef } from './types'

const enabled =
  process.env.RUN_OPERATOR_DB_INTEGRATION === '1' &&
  /^postgres(?:ql)?:\/\/[^/]+\/pathfinder_disposable_[a-z0-9_]+(?:\?|$)/u.test(
    process.env.DATABASE_URL ?? '',
  )

const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
const accountId = `draft-account-${suffix}`
const otherAccountId = `draft-other-account-${suffix}`
const organizationId = `draft-org-${suffix}`
const campaignId = `draft-campaign-${suffix}`
const memberId = `draft-member-${suffix}`

const mailbox: ProviderMailboxRef = {
  provider: 'GMAIL',
  providerAccountId: accountId,
  mailboxId: `ext-${suffix}`,
  mailboxAddress: `drafts-${suffix}@example.com`,
  credentialRef: 'credential-ref-test-only',
}

async function createDraft(input: {
  id: string
  version: number
  status: 'NEEDS_REVIEW' | 'SENT'
  providerDraftAccountId: string | null
  providerDraftId: string | null
}) {
  await db.prospectOutreachDraft.create({
    data: {
      id: input.id,
      campaignId,
      memberId,
      organizationId,
      version: input.version,
      status: input.status,
      toEmail: `person-${suffix}@example.com`,
      subject: 'Example draft',
      textBody: 'Draft text',
      contentHash: randomBytes(32).toString('hex'),
      groundingSnapshot: {},
      generatedByType: 'HUMAN',
      generatedById: 'seed',
      providerDraftAccountId: input.providerDraftAccountId,
      providerDraftId: input.providerDraftId,
    },
  })
}

describe.skipIf(!enabled)('Prisma provider draft reference store (disposable PostgreSQL)', () => {
  beforeAll(async () => {
    await withTenantIsolationBypass(async () => {
      for (const id of [accountId, otherAccountId]) {
        await db.correspondenceProviderAccount.create({
          data: {
            id,
            provider: 'GMAIL',
            externalAccountId: `ext-${id}`,
            mailboxAddress: `${id}@example.com`,
            displayName: 'Example mailbox',
            connectionStatus: 'CONNECTED',
            capabilities: ['RECEIVE'],
            createdBy: 'seed',
            updatedBy: 'seed',
          },
        })
      }
      await db.prospectOrganization.create({
        data: {
          id: organizationId,
          canonicalName: `Example Drafts ${suffix}`,
          normalizedName: `example drafts ${suffix}`,
          createdBy: 'seed',
          updatedBy: 'seed',
          opportunity: { create: { stage: 'RESEARCHED', createdBy: 'seed', updatedBy: 'seed' } },
        },
      })
      await db.prospectOutreachCampaign.create({
        data: {
          id: campaignId,
          name: 'Example campaign',
          cohortSnapshot: {},
          playbookVersion: 'test',
          createdBy: 'seed',
          updatedBy: 'seed',
        },
      })
      await db.prospectCampaignMember.create({ data: { id: memberId, campaignId, organizationId } })
    })
    await createDraft({
      id: `local-only-${suffix}`,
      version: 1,
      status: 'NEEDS_REVIEW',
      providerDraftAccountId: null,
      providerDraftId: null,
    })
    await createDraft({
      id: `present-${suffix}`,
      version: 2,
      status: 'NEEDS_REVIEW',
      providerDraftAccountId: accountId,
      providerDraftId: `r-present-${suffix}`,
    })
    await createDraft({
      id: `gone-${suffix}`,
      version: 3,
      status: 'NEEDS_REVIEW',
      providerDraftAccountId: accountId,
      providerDraftId: `r-gone-${suffix}`,
    })
    await createDraft({
      id: `other-account-${suffix}`,
      version: 4,
      status: 'NEEDS_REVIEW',
      providerDraftAccountId: otherAccountId,
      providerDraftId: `r-other-${suffix}`,
    })
  }, 120_000)

  it('lists only references owned by the exact provider account', async () => {
    const store = createPrismaProviderDraftReferenceStore()
    const rows = await store.listReferencedDrafts({ providerAccountId: accountId, limit: 10 })
    expect(rows.map((row) => row.localDraftId).sort()).toEqual(
      [`gone-${suffix}`, `present-${suffix}`].sort(),
    )
  })

  it('releases one confirmed-absent reference with compare-and-set and an audit row, leaving status alone', async () => {
    const reader: ProviderDraftReader = {
      listPage: async () => ({
        drafts: [
          {
            providerDraftId: `r-present-${suffix}`,
            providerMessageId: `m-${suffix}`,
            providerThreadId: `t-${suffix}`,
          },
          {
            providerDraftId: `r-unknown-${suffix}`,
            providerMessageId: `m2-${suffix}`,
            providerThreadId: `t2-${suffix}`,
          },
        ],
        nextPageToken: null,
      }),
      get: async () => null,
    }
    const result = await reconcileGmailProviderDrafts({
      mailbox,
      reader,
      store: createPrismaProviderDraftReferenceStore(),
    })
    expect(result).toEqual({
      complete: true,
      providerDraftsSeen: 2,
      referencedLocalDrafts: 2,
      referencesConfirmedPresent: 1,
      referencesReleasedAsAbsent: 1,
      unreferencedProviderDrafts: 1,
    })

    const drafts = await db.prospectOutreachDraft.findMany({
      where: { campaignId },
      orderBy: { version: 'asc' },
      select: { id: true, status: true, providerDraftAccountId: true, providerDraftId: true },
    })
    expect(drafts).toEqual([
      {
        id: `local-only-${suffix}`,
        status: 'NEEDS_REVIEW',
        providerDraftAccountId: null,
        providerDraftId: null,
      },
      {
        id: `present-${suffix}`,
        status: 'NEEDS_REVIEW',
        providerDraftAccountId: accountId,
        providerDraftId: `r-present-${suffix}`,
      },
      {
        id: `gone-${suffix}`,
        status: 'NEEDS_REVIEW',
        providerDraftAccountId: null,
        providerDraftId: null,
      },
      {
        id: `other-account-${suffix}`,
        status: 'NEEDS_REVIEW',
        providerDraftAccountId: otherAccountId,
        providerDraftId: `r-other-${suffix}`,
      },
    ])
    const audits = await withTenantIsolationBypass(() =>
      db.auditLog.findMany({
        where: { action: 'prospect_draft.provider_draft_absent', targetId: `gone-${suffix}` },
        select: { actorType: true, beforeState: true, afterState: true },
      }),
    )
    expect(audits).toEqual([
      expect.objectContaining({
        actorType: 'SYSTEM',
        beforeState: { providerDraftAccountId: accountId, providerDraftId: `r-gone-${suffix}` },
        afterState: expect.objectContaining({ localStatusChanged: false }),
      }),
    ])
  })

  it('refuses a stale or cross-account release without writing', async () => {
    const store = createPrismaProviderDraftReferenceStore()
    await expect(
      store.releaseAbsentReference({
        providerAccountId: accountId,
        localDraftId: `gone-${suffix}`,
        providerDraftId: `r-gone-${suffix}`,
        observedAt: new Date(),
      }),
    ).resolves.toBe(false)
    await expect(
      store.releaseAbsentReference({
        providerAccountId: accountId,
        localDraftId: `other-account-${suffix}`,
        providerDraftId: `r-other-${suffix}`,
        observedAt: new Date(),
      }),
    ).resolves.toBe(false)
    const other = await db.prospectOutreachDraft.findUnique({
      where: { id: `other-account-${suffix}` },
      select: { providerDraftId: true },
    })
    expect(other?.providerDraftId).toBe(`r-other-${suffix}`)
  })
})
