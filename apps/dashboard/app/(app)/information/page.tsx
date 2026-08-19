import Link from 'next/link'
import { redirect } from 'next/navigation'

import { IntakeFileUploadWorkspace } from '../../../components/IntakeFileUpload'
import { IntakeProposalWorkspace } from '../../../components/IntakeProposalWorkspace'
import { ClientSectionHeading } from '../../../components/ClientPortalPrimitives'
import { createDashboardCaller } from '../../../lib/server-caller'
import styles from './information.module.css'

type InformationPageProps = {
  searchParams: Promise<{ venue?: string }>
}

export default async function InformationPage({ searchParams }: InformationPageProps) {
  const caller = await createDashboardCaller('/information')
  const venues = await caller.venue.list()
  if (!venues.length) redirect('/onboarding/setup')

  const query = await searchParams
  const venue = venues.find((candidate) => candidate.id === query.venue) ?? venues[0]!
  const [uploadPage, proposals] = await Promise.all([
    caller.intakeUpload.list({ venueId: venue.id, limit: 50 }),
    caller.intake.listProposals({ venueId: venue.id, limit: 50 }),
  ])

  return (
    <div className={styles.page}>
      <div className={styles.frame}>
        <ClientSectionHeading
          headingId="information-title"
          eyebrow="Your information"
          title={`What Torchiko knows about ${venue.name}`}
          summary="Add useful source material whenever something changes. Torchiko keeps it attached to this venue and never publishes it from this page."
          headingLevel={1}
        />
        {venues.length > 1 ? (
          <nav className={styles.venueRail} aria-label="Choose venue information">
            {venues.map((candidate) => (
              <Link
                key={candidate.id}
                href={`/information?venue=${encodeURIComponent(candidate.id)}`}
                aria-current={candidate.id === venue.id ? 'page' : undefined}
              >
                {candidate.name}
              </Link>
            ))}
          </nav>
        ) : null}
        <div className={styles.workspace}>
          <IntakeFileUploadWorkspace
            venueId={venue.id}
            uploads={uploadPage.items}
            nextCursor={uploadPage.nextCursor}
          />
          <details className={styles.sourceDetails}>
            <summary>Add a website or staff knowledge</summary>
            <p>
              These are optional source paths. Sharing them creates reviewable evidence; it does not
              publish visitor content.
            </p>
            <IntakeProposalWorkspace venueId={venue.id} proposals={proposals} />
          </details>
        </div>
      </div>
    </div>
  )
}
