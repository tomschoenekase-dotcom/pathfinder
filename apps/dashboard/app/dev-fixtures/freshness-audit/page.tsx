import { FreshnessAuditView } from '../../../components/admin/FreshnessAuditView'
import { TRPCProvider } from '../../../lib/trpc'

const empty = { items: [], nextCursor: null }
const observedAt = new Date('2026-08-27T15:00:00.000Z')

export default function FreshnessAuditFixture() {
  const content = {
    id: 'fixture-place',
    entityType: 'PLACE' as const,
    label: 'North Gallery',
    category: null,
    sourceType: 'OFFICIAL_DOCUMENT',
    sourceName: 'Summer visitor guide',
    sourceUrl: 'https://example.test/visitor-guide',
    importedAt: new Date('2026-05-01T12:00:00.000Z'),
    humanConfirmedAt: new Date('2026-05-02T12:00:00.000Z'),
    lastReviewedAt: new Date('2026-05-02T12:00:00.000Z'),
    updatedAt: new Date('2026-05-02T12:00:00.000Z'),
  }
  return (
    <main className="min-h-screen bg-slate-100 p-4 sm:p-8">
      <div className="mx-auto max-w-5xl rounded-3xl border border-pf-light bg-slate-50 p-4 sm:p-7">
        <TRPCProvider scopeKey="freshness-audit-fixture">
          <FreshnessAuditView
            tenantId="fixture-tenant"
            venueId="fixture-venue"
            thresholdDays={60}
            horizonDays={14}
            observedAt={observedAt}
            stalePlaces={{ items: [content], nextCursor: null }}
            staleKnowledge={empty}
            gapPlaces={{
              items: [
                {
                  ...content,
                  id: 'fixture-gap',
                  label: 'Family arrival guide',
                  sourceType: 'UNKNOWN',
                  sourceName: null,
                  lastReviewedAt: null,
                },
              ],
              nextCursor: null,
            }}
            gapKnowledge={empty}
            dateSensitive={{
              items: [
                {
                  id: 'fixture-expired',
                  title: 'Atrium elevator maintenance',
                  updateType: 'MAINTENANCE',
                  severity: 'WARNING',
                  priority: 'HIGH',
                  startsAt: new Date('2026-08-26T13:00:00.000Z'),
                  expiresAt: new Date('2026-08-27T14:00:00.000Z'),
                  publishedAt: new Date('2026-08-26T12:00:00.000Z'),
                  updatedAt: new Date('2026-08-26T12:00:00.000Z'),
                  place: { id: 'atrium', name: 'Main atrium' },
                  temporalState: 'EXPIRED',
                  guestVisibleNow: false,
                  cleanupPending: true,
                },
                {
                  id: 'fixture-live',
                  title: 'West entrance closes early',
                  updateType: 'CHANGED_HOURS',
                  severity: 'INFO',
                  priority: 'NORMAL',
                  startsAt: new Date('2026-08-27T13:00:00.000Z'),
                  expiresAt: new Date('2026-08-27T20:00:00.000Z'),
                  publishedAt: new Date('2026-08-27T12:00:00.000Z'),
                  updatedAt: new Date('2026-08-27T12:00:00.000Z'),
                  place: { id: 'west', name: 'West entrance' },
                  temporalState: 'LIVE',
                  guestVisibleNow: true,
                  cleanupPending: false,
                },
                {
                  id: 'fixture-scheduled',
                  title: 'Planetarium evening program',
                  updateType: 'SPECIAL_EVENT',
                  severity: 'INFO',
                  priority: 'NORMAL',
                  startsAt: new Date('2026-08-28T22:00:00.000Z'),
                  expiresAt: new Date('2026-08-29T02:00:00.000Z'),
                  publishedAt: new Date('2026-08-27T12:00:00.000Z'),
                  updatedAt: new Date('2026-08-27T12:00:00.000Z'),
                  place: { id: 'planetarium', name: 'Planetarium' },
                  temporalState: 'SCHEDULED',
                  guestVisibleNow: false,
                  cleanupPending: false,
                },
              ],
              nextCursor: null,
            }}
          />
        </TRPCProvider>
      </div>
    </main>
  )
}
