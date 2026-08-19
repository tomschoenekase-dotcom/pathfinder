'use client'

import { useEffect, useState } from 'react'

import { IntakeFileUpload } from '../../../components/IntakeFileUpload'

export type UploadFixtureState = 'selected' | 'uploading' | 'error' | 'joined'

export function UploadStateFixture({ state }: { state: UploadFixtureState }) {
  const [browserReady, setBrowserReady] = useState(false)
  useEffect(() => setBrowserReady(true), [])

  if (!browserReady)
    return (
      <p className="min-h-screen bg-[#fbfaf6] px-6 py-12 text-sm text-pf-deep" role="status">
        Preparing the upload state…
      </p>
    )

  const file = new File([new Uint8Array(16)], 'museum-arrival-guide.pdf', {
    type: 'application/pdf',
    lastModified: 1_800_000_000_000,
  })
  const phase = state === 'joined' ? 'awaiting-review' : state

  return (
    <main className="min-h-screen bg-[#edf5f5] px-4 py-10 text-pf-deep sm:px-8">
      <div className="mx-auto max-w-5xl">
        <p className="mb-6 text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary">
          Development fixture · {state}
        </p>
        <IntakeFileUpload
          venueId="fixture-upload-venue"
          uploads={[]}
          initialQueue={[
            {
              localId: `fixture-${state}`,
              file,
              category: 'DOCUMENT',
              phase,
              error:
                state === 'error'
                  ? 'The connection paused before Torchiko could confirm this file. Retry to continue.'
                  : null,
              ...(state === 'uploading' ? { uploadedBytes: 8, multipart: true } : {}),
            },
          ]}
          reserve={async () => {
            throw new Error('Visual fixtures never reserve storage')
          }}
          verify={async () => {
            throw new Error('Visual fixtures never verify storage')
          }}
        />
      </div>
    </main>
  )
}
