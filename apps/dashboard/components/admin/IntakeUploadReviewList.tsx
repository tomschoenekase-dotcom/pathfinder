type IntakeUploadReviewItem = {
  id: string
  status: string
  displayName: string
  fileName: string
  mimeType: string
  byteSize: number
  rejectionCode: string | null
  intakeRunId: string | null
  createdAt: Date
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function uploadStatusLabel(status: string): string {
  switch (status) {
    case 'RESERVED':
      return 'Waiting for upload'
    case 'VERIFYING':
      return 'Checking file format'
    case 'PRECHECK_PASSED':
      return 'Security check pending'
    case 'AWAITING_REVIEW':
      return 'Checks complete — awaiting review'
    case 'REJECTED':
      return 'Could not be accepted'
    default:
      return 'Status unavailable'
  }
}

function rejectionReason(code: string): string {
  switch (code) {
    case 'OBJECT_MISSING':
      return 'The uploaded file could not be found.'
    case 'GENERATION_MISMATCH':
    case 'MIME_MISMATCH':
    case 'SIZE_MISMATCH':
    case 'HASH_MISMATCH':
      return 'The uploaded file did not match its submission.'
    case 'UNSAFE_FILE':
      return 'The file did not pass the required checks.'
    default:
      return 'The file could not be accepted.'
  }
}

export function IntakeUploadReviewList({ uploads }: { uploads: IntakeUploadReviewItem[] }) {
  return (
    <section
      className="rounded-2xl border border-pf-light bg-white p-5"
      aria-labelledby="quarantine-review-title"
    >
      <h3 id="quarantine-review-title" className="font-semibold text-pf-deep">
        Quarantined document and image evidence
      </h3>
      <p className="mt-1 text-sm leading-6 text-pf-deep/75">
        Safe metadata only. File-format and security checks are separate. A completed security check
        records one scanner result for the exact stored file; it is not a guarantee that a file is
        malware-free. This view cannot preview, download, approve, apply, or publish files.
      </p>
      {uploads.length === 0 ? (
        <p className="mt-4 text-sm text-pf-deep/65">No quarantined file submissions.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {uploads.map((upload) => (
            <li key={upload.id} className="rounded-xl border border-pf-light p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="break-all text-sm font-medium text-pf-deep">{upload.displayName}</p>
                  <p className="mt-1 break-all text-xs text-pf-deep/65">{upload.fileName}</p>
                </div>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium uppercase tracking-wide text-slate-700">
                  {uploadStatusLabel(upload.status)}
                </span>
              </div>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
                <div>
                  <dt className="text-pf-deep/60">Declared type</dt>
                  <dd className="mt-0.5 text-pf-deep">{upload.mimeType}</dd>
                </div>
                <div>
                  <dt className="text-pf-deep/60">Size</dt>
                  <dd className="mt-0.5 text-pf-deep">{formatBytes(upload.byteSize)}</dd>
                </div>
                <div>
                  <dt className="text-pf-deep/60">Received</dt>
                  <dd className="mt-0.5 text-pf-deep">{upload.createdAt.toLocaleString()}</dd>
                </div>
              </dl>
              {upload.rejectionCode ? (
                <p className="mt-3 text-sm text-rose-700" role="status">
                  {rejectionReason(upload.rejectionCode)}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
