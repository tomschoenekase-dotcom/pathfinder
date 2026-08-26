import { notFound } from 'next/navigation'

import { AdminSectionShell } from '../../../components/admin/AdminSectionShell'
import { AnswerAttributionAgreementCard } from '../../../components/admin/AnswerAttributionAgreementCard'
import { GuestAnswerEvaluationPanel } from '../../../components/admin/GuestAnswerEvaluationPanel'
import { ClientWorkspaceShell } from '../../../components/admin/ClientWorkspaceShell'
import { ReleaseEvidenceSummary } from '../../../components/admin/ReleaseEvidenceSummary'
import { VenueFeatureAccessControl } from '../../../components/admin/VenueFeatureAccessControl'
import { TRPCProvider } from '../../../lib/trpc'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Torchiko authenticated operations browser fixture' }

type Props = { searchParams: Promise<{ surface?: string }> }

function AdminFixture() {
  type ReleaseEvidence = Parameters<typeof ReleaseEvidenceSummary>[0]['evidence']
  type ReleaseRecord = NonNullable<ReleaseEvidence['current']>
  const releaseRecord: ReleaseRecord = {
    id: 'fixture-release-evidence',
    operationId: '00000000-0000-4000-8000-000000000001',
    operationHash: 'a'.repeat(64),
    evidenceHash: 'b'.repeat(64),
    revision: '67f48d18a7f6a4d1c01e1dd884415a2ecb710ee9',
    profile: 'candidate',
    readiness: 'ready-for-staging-review',
    assessmentGeneratedAt: new Date('2026-08-24T18:00:00.000Z'),
    repositoryClean: true,
    passed: 26,
    failed: 0,
    blocked: 0,
    gates: [{ id: 'candidate-verification', status: 'pass', durationMs: 84_000 }],
    limitations: ['Production activation remains founder-gated.'],
    rollback: {
      application: 'Redeploy the previously verified application revision.',
      database: 'Use a reviewed forward-fix migration; no destructive rollback is implied.',
      runbook: 'docs/release-verification.md',
    },
    stagingHandoff: {
      artifactSha256: 'c'.repeat(64),
      status: 'ready-for-owner-staging-integration',
      baseRevision: '1f6f46263a76085905a0e606f74a4fac221bdfbe',
      baseIsAncestor: true,
      ahead: 8,
      behind: 0,
      changedFiles: 24,
      patchSha256: 'd'.repeat(64),
      migrationCount: 183,
      latestMigration: '20260825007000_add_operational_usage_evidence',
      migrationChainSha256: 'e'.repeat(64),
      requiredActions: ['Owner reviews the staging handoff before integration.'],
      retainedGates: ['No production deployment is authorized.'],
    },
    sourceReference: 'artifacts/release-verification/candidate.json',
    recordedByType: 'AGENT',
    recordedById: 'codex-release-worker',
    credentialId: 'fixture-credential',
    createdAt: new Date('2026-08-24T18:01:00.000Z'),
  }
  const releaseEvidence: ReleaseEvidence = {
    schemaVersion: 'torchiko.platform-release-evidence.v1',
    generatedAt: new Date('2026-08-24T18:02:00.000Z'),
    current: releaseRecord,
    items: [releaseRecord],
    boundaries: {
      evidenceOnly: true,
      stagingDeploymentAuthorized: false,
      productionDeploymentAuthorized: false,
      productionMigrationAuthorized: false,
      customerContactAuthorized: false,
      liveBillingAuthorized: false,
      valuableDataDestructionAuthorized: false,
    },
  }

  return (
    <TRPCProvider scopeKey="authenticated-admin-visual-fixture">
      <AdminSectionShell routePathname="/admin/operations">
        <div data-fixture="authenticated-operations" data-fixture-surface="admin">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">
            Deterministic Founder Control Room fixture
          </p>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
                Founder Control Room
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                Synthetic operational evidence only. This fixture cannot approve work, contact a
                customer, or mutate company state.
              </p>
            </div>
            <span className="w-fit rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
              Local evidence current
            </span>
          </div>

          <section className="mt-7 grid gap-4 md:grid-cols-3" aria-label="Founder briefing">
            {[
              ['Needs your decision', '2', 'Pricing and production release remain founder-gated.'],
              ['Agents waiting', '1', 'One synthetic workflow is paused for an approval.'],
              ['Customer impact', 'None', 'No customer-facing incident is represented here.'],
            ].map(([label, value, detail]) => (
              <article
                key={label}
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  {label}
                </p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
                <p className="mt-2 text-sm leading-5 text-slate-600">{detail}</p>
              </article>
            ))}
          </section>

          <section
            className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-5"
            aria-labelledby="fixture-decision"
          >
            <p className="text-xs font-semibold uppercase tracking-wider text-amber-800">
              Compact decision
            </p>
            <h2 id="fixture-decision" className="mt-2 text-lg font-semibold text-amber-950">
              Staging release awaits owner awareness
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-amber-900">
              The candidate is locally verified. This visual fixture records no approval and exposes
              no production action.
            </p>
          </section>

          <div className="mt-5">
            <ReleaseEvidenceSummary evidence={releaseEvidence} />
          </div>
          <div className="mt-5">
            <AnswerAttributionAgreementCard
              data={{
                reportHash: 'f'.repeat(64),
                invalidRecordCount: 0,
                truncated: false,
                report: {
                  inputRecordCount: 4,
                  selectedRecordCount: 4,
                  turnCount: 2,
                  comparableGroupCount: 2,
                  independentPairCount: 2,
                  distinctReviewerCount: 2,
                  exclusions: {
                    repeatedReviewerRecordCount: 0,
                    singleReviewerGroupCount: 0,
                    identityConflictTurnCount: 0,
                  },
                  metrics: {
                    coverageOverlapRate: 0.92,
                    supportAgreementRate: 0.86,
                    sourceAgreementRate: 0.8,
                  },
                },
              }}
            />
          </div>
          <div className="mt-5">
            <GuestAnswerEvaluationPanel
              tenantId="fixture-tenant"
              venueId="fixture-venue"
              readiness={{
                processEnabled: false,
                durableGlobalEnabled: false,
                tenantEnabled: false,
              }}
              executionEnabled={false}
              requests={[
                {
                  id: '10000000-0000-4000-8000-000000000001',
                  guestChatTurnId: '20000000-0000-4000-8000-000000000001',
                  answerHash: 'a'.repeat(64),
                  evidenceSetHash: 'b'.repeat(64),
                  status: 'STAGED',
                  attemptNumber: 0,
                  providerDispatchedAt: null,
                  resultAttributionId: null,
                  lastErrorCode: null,
                  createdAt: new Date('2026-08-25T11:00:00.000Z'),
                },
              ]}
            />
          </div>
        </div>
      </AdminSectionShell>
    </TRPCProvider>
  )
}

function WorkspaceFixture() {
  return (
    <main
      className="min-h-screen bg-pf-cream p-3 text-pf-deep sm:p-6"
      data-fixture="authenticated-operations"
      data-fixture-surface="workspace"
    >
      <ClientWorkspaceShell
        routePathname="/admin/clients/fixture-client/venues/fixture-venue/content"
        billingAvailable
        client={{
          id: 'fixture-client',
          name: 'Great Lakes Museum Group',
          slug: 'great-lakes-museum-group',
          status: 'ACTIVE',
        }}
        venues={[
          {
            id: 'fixture-venue',
            name: 'Harbor Discovery Museum',
            slug: 'harbor-discovery-museum',
            isActive: true,
            guestUrl: 'https://example.invalid/harbor-discovery-museum',
          },
          {
            id: 'fixture-venue-2',
            name: 'Lakeside Science Annex',
            slug: 'lakeside-science-annex',
            isActive: false,
            guestUrl: null,
          },
        ]}
      >
        <section aria-labelledby="workspace-fixture-title">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary">
            Synthetic venue content state
          </p>
          <h2 id="workspace-fixture-title" className="mt-2 text-2xl font-semibold tracking-tight">
            Universal content
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-pf-deep/75">
            Venue-scoped content and provenance remain separate from the organization-wide record.
            No customer data is read or changed by this fixture.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <article className="rounded-2xl border border-pf-light bg-white p-4">
              <p className="text-xs font-bold uppercase tracking-wider text-pf-deep/75">
                Current truth
              </p>
              <p className="mt-2 font-semibold">Accessible entrance: Harbor Street</p>
              <p className="mt-1 text-sm text-pf-deep/70">Verified synthetic source · August 24</p>
            </article>
            <article className="rounded-2xl border border-pf-light bg-white p-4">
              <p className="text-xs font-bold uppercase tracking-wider text-pf-deep/75">
                Historical truth
              </p>
              <p className="mt-2 font-semibold">Old east-door directions retained</p>
              <p className="mt-1 text-sm text-pf-deep/70">
                Superseded and excluded from guest answers
              </p>
            </article>
          </div>
        </section>
      </ClientWorkspaceShell>
    </main>
  )
}

function FeatureAccessFixture() {
  return (
    <TRPCProvider scopeKey="feature-access-visual-fixture">
      <main
        className="min-h-screen bg-pf-cream p-3 text-pf-deep sm:p-6"
        data-fixture="authenticated-operations"
        data-fixture-surface="feature-access"
      >
        <ClientWorkspaceShell
          routePathname="/admin/clients/fixture-client/venues/fixture-venue/feature-access"
          billingAvailable
          client={{
            id: 'fixture-client',
            name: 'Great Lakes Museum Group',
            slug: 'great-lakes-museum-group',
            status: 'ACTIVE',
          }}
          venues={[
            {
              id: 'fixture-venue',
              name: 'Harbor Discovery Museum',
              slug: 'harbor-discovery-museum',
              isActive: true,
              guestUrl: 'https://example.invalid/harbor-discovery-museum',
            },
          ]}
        >
          <VenueFeatureAccessControl
            tenantId="fixture-client"
            venueId="fixture-venue"
            venueName="Harbor Discovery Museum"
            entitlements={[
              {
                capability: 'voice',
                enabled: false,
                source: 'DEFAULT',
                sourceId: null,
                planTier: 'launch',
                settings: {},
                validUntil: null,
              },
            ]}
          />
        </ClientWorkspaceShell>
      </main>
    </TRPCProvider>
  )
}

export default async function AuthenticatedOperationsFixturePage({ searchParams }: Props) {
  if (process.env.NODE_ENV !== 'development') notFound()
  const surface = (await searchParams).surface
  if (surface === 'workspace') return <WorkspaceFixture />
  if (surface === 'feature-access') return <FeatureAccessFixture />
  return <AdminFixture />
}
