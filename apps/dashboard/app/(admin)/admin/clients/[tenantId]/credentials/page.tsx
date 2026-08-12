export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { ExternalCredentialLifecycleWorkspace } from '../../../../../../components/admin/ExternalCredentialLifecycleWorkspace'
import { createAdminCaller } from '../../../../../../lib/admin-caller'

type Props = {
  params: Promise<{ tenantId: string }>
  searchParams: Promise<Record<string, string | undefined>>
}

function state(credential: { enabled: boolean; revokedAt: Date | null; expiresAt: Date | null }) {
  if (credential.revokedAt) return 'Revoked'
  if (credential.expiresAt && credential.expiresAt <= new Date()) return 'Expired'
  return credential.enabled ? 'Marked enabled (external access disabled)' : 'Disabled'
}

function kindLabel(kind: string) {
  if (kind === 'MCP') return 'MCP'
  if (kind === 'PARTNER_READ_API') return 'Partner Read API'
  return 'Credential kind unavailable'
}

const SAFE_CAPABILITIES = new Set([
  'resources:read',
  'clients:read',
  'venues:read',
  'configuration:read',
  'content:read',
  'history:read',
  'packages:read',
  'support:read',
  'updates:read',
  'ai-usage:read',
  'jobs:read',
  'evaluations:read',
  'readiness:read',
  'packages:draft',
  'support:draft',
  'updates:draft',
  'evaluations:request',
  'approved-content:read',
])

function capabilityLabel(capability: string) {
  return SAFE_CAPABILITIES.has(capability) ? capability : 'Capability unavailable'
}

function revocationReasonLabel(code: string) {
  if (code === 'ROTATED') return 'Rotated'
  if (code === 'ADMIN_REVOKED') return 'Administrative revocation'
  if (code === 'NO_LONGER_NEEDED') return 'No longer needed'
  if (code === 'POSSIBLE_COMPROMISE') return 'Possible compromise'
  return 'Reason unavailable'
}

export default async function ExternalCredentialsPage({ params, searchParams }: Props) {
  const { tenantId } = await params
  const query = await searchParams
  const caller = await createAdminCaller()
  try {
    const client = await caller.admin.getClient({ tenantId })
    const cursor =
      query.credentialCursorCreatedAt && query.credentialCursorId
        ? { createdAt: query.credentialCursorCreatedAt, id: query.credentialCursorId }
        : undefined
    const page = await caller.admin.listExternalCredentials({
      tenantId,
      clientId: tenantId,
      limit: 25,
      ...(cursor ? { cursor } : {}),
    })
    const selectedId = query.credentialId ?? page.items[0]?.id ?? null
    const selectedRow = page.items.find((item) => item.id === selectedId) ?? null
    const loadedDetail =
      selectedId && selectedRow
        ? await caller.admin.getExternalCredential({
            tenantId,
            clientId: tenantId,
            credentialId: selectedId,
            venueId: selectedRow.venueId,
          })
        : null
    const detail = loadedDetail
      ? {
          ...loadedDetail,
          revocation: loadedDetail.revocation
            ? {
                ...loadedDetail.revocation,
                reasonCode: revocationReasonLabel(loadedDetail.revocation.reasonCode),
              }
            : null,
        }
      : null
    const cursorSuffix =
      query.credentialCursorCreatedAt && query.credentialCursorId
        ? `&credentialCursorCreatedAt=${encodeURIComponent(query.credentialCursorCreatedAt)}&credentialCursorId=${encodeURIComponent(query.credentialCursorId)}`
        : ''
    const base = `/admin/clients/${tenantId}/credentials`
    return (
      <div className="space-y-8">
        <header>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
            Access foundations
          </p>
          <h2 className="mt-1 text-2xl font-semibold text-pf-deep">External credentials</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
            Record and manage disabled metadata for future MCP and Partner Read API credentials.
            Nothing on this page enables or authenticates external access.
          </p>
        </header>
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <h3 className="font-semibold text-amber-950">No plaintext secret is stored</h3>
          <p className="mt-1 text-sm text-amber-950">
            A newly issued or rotated secret may appear once in the action response. After it is
            dismissed, only a non-sensitive prefix remains visible. Stored one-way hashes are
            deliberately omitted from every response.
          </p>
        </section>
        {page.items.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-pf-light p-8 text-center text-sm text-pf-deep/75">
            No credential metadata exists for this client. The credential system remains disabled.
          </p>
        ) : (
          <div className="grid gap-6 xl:grid-cols-[20rem_minmax(0,1fr)]">
            <aside aria-label="External credentials" className="space-y-2">
              {page.items.map((item) => (
                <Link
                  key={item.id}
                  href={`${base}?credentialId=${encodeURIComponent(item.id)}${cursorSuffix}`}
                  aria-current={detail?.id === item.id ? 'page' : undefined}
                  className={`block rounded-2xl border p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2 ${detail?.id === item.id ? 'border-pf-primary bg-pf-surface' : 'border-pf-light bg-white'}`}
                >
                  <div className="flex justify-between gap-3">
                    <span className="text-xs font-bold text-pf-primary">
                      {kindLabel(item.kind)}
                    </span>
                    <span className="text-xs text-pf-deep/75">{state(item)}</span>
                  </div>
                  <p className="mt-2 font-semibold text-pf-deep">{item.label}</p>
                  <p className="mt-1 font-mono text-xs text-pf-deep/75">{item.secretPrefix}…</p>
                </Link>
              ))}
              {page.nextCursor ? (
                <Link
                  href={`${base}?credentialCursorCreatedAt=${encodeURIComponent(page.nextCursor.createdAt)}&credentialCursorId=${encodeURIComponent(page.nextCursor.id)}`}
                  className="inline-flex min-h-11 items-center text-sm font-semibold text-pf-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
                >
                  Older credentials
                </Link>
              ) : null}
            </aside>
            {detail ? (
              <main className="min-w-0 space-y-5">
                <section className="rounded-2xl border border-pf-light bg-white p-5">
                  <div className="flex flex-wrap justify-between gap-3">
                    <div>
                      <h3 className="text-xl font-semibold text-pf-deep">{detail.label}</h3>
                      <p className="mt-1 font-mono text-xs text-pf-deep/75">
                        Credential {detail.id}
                      </p>
                    </div>
                    <span className="rounded-full bg-pf-surface px-3 py-1 text-xs font-bold text-pf-deep">
                      {state(detail)}
                    </span>
                  </div>
                  <dl className="mt-5 grid gap-4 sm:grid-cols-2">
                    <Field label="Kind" value={kindLabel(detail.kind)} />
                    <Field
                      label="Scope"
                      value={
                        detail.venueId ? `Venue ${detail.venueId}` : `Client ${detail.clientId}`
                      }
                    />
                    <Field label="Visible prefix" value={`${detail.secretPrefix}…`} />
                    <Field label="Hash algorithm" value={detail.hashAlgorithm} />
                    <Field
                      label="Expires"
                      value={detail.expiresAt?.toLocaleString() ?? 'No expiry recorded'}
                    />
                    <Field
                      label="Last used"
                      value={detail.lastUsedAt?.toLocaleString() ?? 'Never recorded'}
                    />
                  </dl>
                  <div className="mt-5">
                    <h4 className="text-sm font-semibold text-pf-deep">Capabilities</h4>
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {detail.capabilities.map((capability) => (
                        <li
                          key={capability}
                          className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-800"
                        >
                          {capabilityLabel(capability)}
                        </li>
                      ))}
                    </ul>
                  </div>
                </section>
                <section className="rounded-2xl border border-pf-light bg-white p-5">
                  <h3 className="text-lg font-semibold text-pf-deep">
                    Immutable lifecycle evidence
                  </h3>
                  {detail.rotationsFrom.length +
                    detail.rotationsTo.length +
                    (detail.revocation ? 1 : 0) ===
                  0 ? (
                    <p className="mt-3 text-sm text-pf-deep/75">
                      No rotation or revocation evidence is recorded.
                    </p>
                  ) : (
                    <ul className="mt-3 space-y-2 text-sm text-pf-deep/75">
                      {detail.rotationsTo.map((event) => (
                        <li key={event.id}>
                          Rotated from {event.previousCredentialId} ·{' '}
                          {event.rotatedAt.toLocaleString()}
                        </li>
                      ))}
                      {detail.rotationsFrom.map((event) => (
                        <li key={event.id}>
                          Rotated to {event.newCredentialId} · {event.rotatedAt.toLocaleString()}
                        </li>
                      ))}
                      {detail.revocation ? (
                        <li>
                          Revoked · {detail.revocation.reasonCode} ·{' '}
                          {detail.revocation.revokedAt.toLocaleString()}
                        </li>
                      ) : null}
                    </ul>
                  )}
                </section>
              </main>
            ) : null}
          </div>
        )}
        <ExternalCredentialLifecycleWorkspace
          tenantId={tenantId}
          clientName={client.tenant.name}
          venues={client.venues.map((venue) => ({ id: venue.id, name: venue.name }))}
          credential={detail}
        />
      </div>
    )
  } catch {
    return (
      <section role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-8">
        <h2 className="text-xl font-semibold text-rose-950">
          Credential metadata could not be loaded
        </h2>
        <p className="mt-2 text-sm text-rose-900">
          No credential or lifecycle operation was attempted.
        </p>
      </section>
    )
  }
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-bold uppercase tracking-wider text-pf-deep/75">{label}</dt>
      <dd className="mt-1 break-all text-sm text-pf-deep">{value}</dd>
    </div>
  )
}
