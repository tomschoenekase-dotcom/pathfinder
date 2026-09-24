'use client'

import type {
  VenueLaunchAssetDescriptor,
  VenueLaunchAssetSelection,
} from '@pathfinder/contracts/venue-launch-asset'

function identity(asset: VenueLaunchAssetSelection) {
  return [
    asset.tenantId,
    asset.venueId,
    asset.release.kind,
    asset.release.id,
    asset.release.revisionSha256,
    asset.publicUrl,
    asset.sha256,
  ].join('|')
}
export function ProspectLaunchAttachmentList({
  assets,
  label,
}: {
  assets: VenueLaunchAssetDescriptor[]
  label: string
}) {
  return (
    <section aria-label={label} className="mt-4 border-t border-slate-200 pt-4 text-sm">
      <h3 className="font-semibold text-slate-900">{label}</h3>
      {assets.map((asset) => (
        <div key={identity(asset)} className="mt-2 min-w-0">
          <p className="break-all font-medium">
            {asset.filename} · {asset.sizeBytes.toLocaleString()} bytes
          </p>
          <a
            className="inline-block min-h-11 break-all py-2 underline focus-visible:outline focus-visible:outline-2"
            href={asset.publicUrl}
            target="_blank"
            rel="noreferrer"
          >
            {asset.publicUrl}
          </a>
          <p>
            {asset.release.kind === 'NATIVE' ? 'Native release' : 'Current legacy public content'}:{' '}
            <span className="break-all">{asset.release.id}</span>
          </p>
          <details>
            <summary className="min-h-11 cursor-pointer py-2">Exact QR and source hashes</summary>
            <p className="break-all font-mono text-xs">File SHA-256: {asset.sha256}</p>
            <p className="mt-1 break-all font-mono text-xs">
              Source SHA-256: {asset.release.revisionSha256}
            </p>
          </details>
        </div>
      ))}
    </section>
  )
}

export function ProspectLaunchAttachmentSelection({
  assets,
  hold,
  selected,
  onChange,
  disabled,
}: {
  assets: VenueLaunchAssetDescriptor[]
  hold: string | null
  selected: VenueLaunchAssetSelection | null
  onChange: (value: VenueLaunchAssetSelection | null) => void
  disabled: boolean
}) {
  const selectedKey = selected ? identity(selected) : ''
  const selectedCurrent = assets.some((asset) => identity(asset) === selectedKey)
  return (
    <fieldset className="mt-4 min-w-0 border-t border-slate-200 pt-4" disabled={disabled}>
      <legend className="pt-4 text-sm font-semibold">Venue QR attachment</legend>
      <label className="block text-sm">
        Include with the next writing preparation
        <select
          value={selectedKey}
          onChange={(event) => {
            const asset = assets.find((candidate) => identity(candidate) === event.target.value)
            onChange(
              asset
                ? {
                    tenantId: asset.tenantId,
                    venueId: asset.venueId,
                    release: asset.release,
                    publicUrl: asset.publicUrl,
                    sha256: asset.sha256,
                  }
                : null,
            )
          }}
          className="mt-2 block min-h-11 w-full min-w-0 rounded-md border border-slate-400 bg-white px-3 text-slate-950 focus-visible:outline focus-visible:outline-2"
        >
          <option value="">No attachment</option>
          {selected && !selectedCurrent ? (
            <option value={selectedKey} disabled>
              Previously selected QR is no longer current — choose again
            </option>
          ) : null}
          {assets.map((asset) => (
            <option key={identity(asset)} value={identity(asset)}>
              {asset.filename}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-2 text-xs leading-5 text-slate-600">
        Selection is saved with a new preparation. Changing the venue source requires a new draft
        and review.
      </p>
      {hold ? <p className="mt-2 text-sm text-slate-700">{hold}</p> : null}
      {selectedCurrent ? (
        <ProspectLaunchAttachmentList
          assets={assets.filter((asset) => identity(asset) === selectedKey)}
          label="Selected QR"
        />
      ) : null}
    </fieldset>
  )
}
