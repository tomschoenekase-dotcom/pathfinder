import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ProspectCampaignWorkbench } from '../../../components/admin/ProspectCampaignWorkbench'
import { ProspectDirectory } from '../../../components/admin/ProspectDirectory'
import { ProspectOutreachCenter } from '../../../components/admin/ProspectOutreachCenter'
import { TRPCProvider } from '../../../lib/trpc'

const now = new Date('2026-08-20T12:00:00Z')
const readiness = {
  deliveryEnabled: false,
  providerConfigured: false,
  inboundConfigured: false,
  limits: { cohort: 5000, batch: 500 },
  policy: { agentsMayDraft: true, agentsMayApprove: false, agentsMaySend: false },
  accounts: [],
  followupReview: {
    generatedAt: now,
    evidenceBounded: false,
    policy: {
      automaticSchedulingAuthorized: false,
      automaticSendingAuthorized: false,
      alternateContactAuthorized: false,
      cadencePolicy: 'UNRESOLVED',
    },
    counts: { due: 1, scheduled: 0, readyForDraft: 0, held: 0 },
    items: [
      {
        id: 'followup-fixture',
        organizationId: 'org-2',
        dueAt: new Date('2026-08-19T12:00:00Z'),
        sequenceNumber: 1,
        status: 'PENDING',
        reason: 'Founder-approved first follow-up schedule',
        policyApprovedAt: new Date('2026-08-18T12:00:00Z'),
        readinessCheckedAt: null,
        organization: { canonicalName: 'Lakeside Art Center', relationshipTier: 'HIGH_VALUE' },
        opportunity: { stage: 'CONTACTED', priority: 'NORMAL', lastActivityAt: now },
        campaignMember: { status: 'CONTACTED' },
        triggerSendItem: { sentAt: new Date('2026-08-12T12:00:00Z') },
        due: true,
        policyApproved: true,
      },
    ],
  },
}

const campaign = {
  id: 'campaign-fixture',
  name: 'Chicago museums · August',
  description: null,
  status: 'DRAFT',
  cohortSnapshot: {},
  playbookVersion: 'torchiko-email-playbook-2026-08-18',
  createdBy: 'fixture',
  updatedBy: 'fixture',
  createdAt: now,
  updatedAt: now,
  members: [
    {
      id: 'member-1',
      campaignId: 'campaign-fixture',
      organizationId: 'org-1',
      venueId: 'venue-1',
      contactId: 'contact-1',
      status: 'NEEDS_REVIEW',
      selection: {},
      createdAt: now,
      updatedAt: now,
      organization: {
        canonicalName: 'North Shore Discovery Museum',
        relationshipTier: 'STRATEGIC',
        priority: 'HIGH',
      },
      venue: { name: 'North Shore Discovery Museum', city: 'Chicago', region: 'IL' },
      contact: {
        fullName: 'Avery Morgan',
        title: 'Director of Visitor Experience',
        email: 'avery@example.test',
        doNotContact: false,
      },
      drafts: [
        {
          id: 'draft-1',
          campaignId: 'campaign-fixture',
          memberId: 'member-1',
          organizationId: 'org-1',
          venueId: 'venue-1',
          contactId: 'contact-1',
          version: 1,
          status: 'NEEDS_REVIEW',
          toEmail: 'avery@example.test',
          subject: 'Torchiko for North Shore Discovery Museum',
          textBody:
            'Hi Avery,\n\nMy name is Tom Schoenekase, and I’m the founder of Torchiko. Visitors could ask which exhibits are best for younger kids or what they should make sure to see with only thirty minutes left.\n\nI’d love to tell you more about how Torchiko could fit the museum.\n\nBest,\nTom',
          htmlBody: null,
          contentHash: 'a'.repeat(64),
          groundingSnapshot: {},
          escalationFlags: ['strategic-prospect'],
          generatedByType: 'AGENT',
          generatedById: 'fixture-agent',
          approvedBy: null,
          approvedAt: null,
          rejectedReason: null,
          createdAt: now,
        },
      ],
    },
    {
      id: 'member-2',
      campaignId: 'campaign-fixture',
      organizationId: 'org-2',
      venueId: 'venue-2',
      contactId: 'contact-2',
      status: 'APPROVED',
      selection: {},
      createdAt: now,
      updatedAt: now,
      organization: {
        canonicalName: 'Lakeside Art Center',
        relationshipTier: 'HIGH_VALUE',
        priority: 'NORMAL',
      },
      venue: { name: 'Lakeside Art Center', city: 'Evanston', region: 'IL' },
      contact: {
        fullName: 'Jordan Lee',
        title: 'Museum Director',
        email: 'jordan@example.test',
        doNotContact: false,
      },
      drafts: [
        {
          id: 'draft-2',
          campaignId: 'campaign-fixture',
          memberId: 'member-2',
          organizationId: 'org-2',
          venueId: 'venue-2',
          contactId: 'contact-2',
          version: 2,
          status: 'APPROVED',
          toEmail: 'jordan@example.test',
          subject: 'Torchiko for Lakeside Art Center',
          textBody:
            'Hi Jordan,\n\nTorchiko gives visitors a conversational guide built around the venue itself. I think it could be a great fit for helping guests explore the collection in a more personal way.\n\nBest,\nTom',
          htmlBody: null,
          contentHash: 'b'.repeat(64),
          groundingSnapshot: {},
          escalationFlags: [],
          generatedByType: 'AGENT',
          generatedById: 'fixture-agent',
          approvedBy: 'fixture',
          approvedAt: now,
          rejectedReason: null,
          createdAt: now,
        },
      ],
    },
  ],
  sendBatches: [
    {
      id: 'batch-1',
      campaignId: 'campaign-fixture',
      status: 'APPROVED',
      recipientCount: 1,
      snapshotHash: 'c'.repeat(64),
      createdBy: 'fixture',
      approvedBy: 'fixture',
      approvedAt: now,
      queuedAt: null,
      completedAt: null,
      cancelledReason: null,
      createdAt: now,
      updatedAt: now,
      _count: { items: 1 },
      items: [
        {
          id: 'send-item-1',
          recipientEmailSnapshot: 'jordan@example.test',
          subjectSnapshot: 'Torchiko for Lakeside Art Center',
          textBodySnapshot:
            'Hi Jordan,\n\nTorchiko gives visitors a conversational guide built around the venue itself. I think it could be a great fit for helping guests explore the collection in a more personal way.\n\nBest,\nTom',
          contentHashSnapshot: 'b'.repeat(64),
        },
      ],
    },
  ],
}

const directory = {
  items: [
    {
      id: 'org-1',
      canonicalName: 'North Shore Discovery Museum',
      website: 'https://example.test',
      normalizedDomain: 'example.test',
      organizationType: 'Museum',
      priority: 'HIGH',
      relationshipTier: 'STRATEGIC',
      ownerId: null,
      archivedAt: null,
      updatedAt: now,
      territory: { id: 't-1', name: 'Chicago North', code: 'CHI-N' },
      opportunity: {
        stage: 'READY_FOR_OUTREACH',
        priority: 'HIGH',
        ownerId: null,
        nextAction: 'Review personalized outreach',
        nextActionAt: now,
        lastActivityAt: now,
      },
      venues: [
        {
          id: 'venue-1',
          name: 'North Shore Discovery Museum',
          city: 'Chicago',
          region: 'IL',
          venueType: 'Museum',
        },
      ],
      contacts: [
        {
          id: 'contact-1',
          fullName: 'Avery Morgan',
          email: 'avery@example.test',
          doNotContact: false,
        },
      ],
      _count: { venues: 1, contacts: 1, activities: 6 },
    },
    {
      id: 'org-2',
      canonicalName: 'Lakeside Art Center',
      website: null,
      normalizedDomain: null,
      organizationType: 'Art museum',
      priority: 'NORMAL',
      relationshipTier: 'HIGH_VALUE',
      ownerId: null,
      archivedAt: null,
      updatedAt: now,
      territory: { id: 't-2', name: 'Evanston', code: 'EVN' },
      opportunity: {
        stage: 'CONTACTED',
        priority: 'NORMAL',
        ownerId: null,
        nextAction: 'First follow-up',
        nextActionAt: new Date('2026-09-02T12:00:00Z'),
        lastActivityAt: now,
      },
      venues: [
        {
          id: 'venue-2',
          name: 'Lakeside Art Center',
          city: 'Evanston',
          region: 'IL',
          venueType: 'Museum',
        },
      ],
      contacts: [
        {
          id: 'contact-2',
          fullName: 'Jordan Lee',
          email: 'jordan@example.test',
          doNotContact: false,
        },
      ],
      _count: { venues: 1, contacts: 1, activities: 3 },
    },
  ],
  nextCursor: 'org-2',
}

export default async function ProspectCrmFixture({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>
}) {
  if (process.env.NODE_ENV !== 'development') notFound()
  const view = (await searchParams).view ?? 'directory'
  return (
    <TRPCProvider scopeKey={`fixture:prospect-crm:${view}`}>
      <main className="min-h-screen bg-slate-50 px-4 py-8 sm:px-8">
        <nav className="mx-auto mb-6 flex max-w-7xl flex-wrap gap-2" aria-label="CRM fixture views">
          {['directory', 'outreach', 'campaign'].map((item) => (
            <Link
              key={item}
              href={`/dev-fixtures/prospect-crm?view=${item}`}
              className={`rounded-full px-3 py-1.5 text-xs font-bold capitalize ${view === item ? 'bg-slate-950 text-white' : 'border border-slate-300 bg-white text-slate-700'}`}
            >
              {item}
            </Link>
          ))}
        </nav>
        <div className="mx-auto max-w-7xl">
          {view === 'directory' ? (
            <ProspectDirectory
              fixture={{
                result: directory as never,
                savedViews: [
                  {
                    id: 'view-1',
                    name: 'Outreach ready',
                    ownerId: 'fixture',
                    filters: { stage: 'READY_FOR_OUTREACH', emailReadiness: 'READY' },
                    columns: [],
                    sort: {},
                    isShared: false,
                    createdAt: now,
                    updatedAt: now,
                  },
                ] as never,
              }}
            />
          ) : view === 'outreach' ? (
            <ProspectOutreachCenter
              fixture={{
                campaigns: [
                  { ...campaign, _count: { members: 2, drafts: 2, sendBatches: 1 } },
                ] as never,
                readiness: readiness as never,
              }}
            />
          ) : (
            <ProspectCampaignWorkbench
              campaignId="campaign-fixture"
              fixture={{ campaign: campaign as never, readiness: readiness as never }}
            />
          )}
        </div>
      </main>
    </TRPCProvider>
  )
}
