'use client'

import { useEffect, useState } from 'react'

import { IntakeFileUpload } from '../../../components/IntakeFileUpload'

export type UploadFixtureState = 'selected' | 'uploading' | 'error' | 'joined' | 'mixed'

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
  const phase = state === 'joined' ? 'awaiting-review' : state === 'mixed' ? 'error' : state
  const mixedQueue =
    state === 'mixed'
      ? [
          {
            localId: 'fixture-mixed-photo',
            file: new File([new Uint8Array(20)], 'gallery-entry.jpg', {
              type: 'image/jpeg',
              lastModified: 1_800_000_000_001,
            }),
            category: 'PHOTO' as const,
            phase: 'awaiting-review' as const,
            error: null,
          },
          {
            localId: 'fixture-mixed-document',
            file,
            category: 'DOCUMENT' as const,
            phase: 'error' as const,
            error:
              'The connection paused before Torchiko could confirm this file. Retry to continue.',
          },
          {
            localId: 'fixture-mixed-invalid',
            file: new File([new Uint8Array(8)], 'installer.exe', {
              type: 'application/x-msdownload',
              lastModified: 1_800_000_000_002,
            }),
            category: 'DOCUMENT' as const,
            phase: 'invalid' as const,
            error: 'Choose a PDF, image, video, audio file, or supported document.',
          },
        ]
      : null

  return (
    <main className="min-h-screen bg-[#edf5f5] px-4 py-10 text-pf-deep sm:px-8">
      <div className="mx-auto max-w-5xl">
        <p className="mb-6 text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary">
          Development fixture · {state}
        </p>
        <IntakeFileUpload
          venueId="fixture-upload-venue"
          uploads={[]}
          initialQueue={
            mixedQueue ?? [
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
            ]
          }
          reserve={async (input) => {
            if (state === 'mixed') {
              return {
                upload: {
                  id: `fixture-upload-${input.requestId}`,
                  displayName: input.displayName,
                  fileName: input.fileName,
                  mimeType: input.mimeType,
                  byteSize: input.byteSize,
                  status: 'AWAITING_REVIEW' as const,
                  rejectionCode: null,
                },
                replayed: false,
                nextAction: 'REVIEW_STATUS' as const,
                uploadRequest: null,
              }
            }
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
