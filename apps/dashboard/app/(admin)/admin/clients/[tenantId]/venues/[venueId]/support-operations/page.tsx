export const dynamic = 'force-dynamic'

import { SupportOperationsView } from '../../../../../../../../components/admin/SupportOperationsView'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

type Props = {
  params: Promise<{ tenantId: string; venueId: string }>
  searchParams: Promise<Record<string, string | undefined>>
}
function requestCursor(query: Record<string, string | undefined>) {
  const updatedAt = query.requestCursorUpdatedAt
  const id = query.requestCursorId
  return updatedAt && id ? { updatedAt, id } : undefined
}
function messageCursor(query: Record<string, string | undefined>) {
  const createdAt = query.messageCursorCreatedAt
  const id = query.messageCursorId
  return createdAt && id ? { createdAt, id } : undefined
}
function auditCursor(query: Record<string, string | undefined>) {
  const version = Number(query.auditCursorRequestVersion)
  const id = query.auditCursorId
  return Number.isInteger(version) && version > 0 && id
    ? { requestVersion: version, id }
    : undefined
}

export default async function SupportOperationsPage({ params, searchParams }: Props) {
  const { tenantId, venueId } = await params
  const query = await searchParams
  const caller = await createAdminCaller()
  try {
    const requestPage = await caller.admin.listSupportRequests({
      tenantId,
      venueId,
      limit: 20,
      ...(requestCursor(query) ? { cursor: requestCursor(query) } : {}),
    })
    const selectedId = query.requestId ?? requestPage.items[0]?.id ?? null
    const normalizeRequest = (request: (typeof requestPage.items)[number]) => ({
      id: request.id,
      category: request.category,
      missingInformation: request.missingInformation,
      status: request.status,
      subject: request.subject,
      version: request.version,
      createdByKind: request.createdByKind,
      updatedByKind: request.updatedByKind,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    })
    const requests = { ...requestPage, items: requestPage.items.map(normalizeRequest) }
    if (!selectedId)
      return (
        <SupportOperationsView
          tenantId={tenantId}
          venueId={venueId}
          requests={requests}
          selected={null}
          messages={{ items: [], nextCursor: null }}
          audit={{ items: [], nextCursor: null }}
          draftPackages={[]}
          handoffs={[]}
        />
      )
    const [selectedRaw, messagePage, audit, draftPackages, handoffs] = await Promise.all([
      caller.admin.getSupportRequest({ tenantId, venueId, requestId: selectedId }),
      caller.admin.listSupportMessages({
        tenantId,
        venueId,
        requestId: selectedId,
        limit: 20,
        ...(messageCursor(query) ? { cursor: messageCursor(query) } : {}),
      }),
      caller.admin.listSupportAuditEvents({
        tenantId,
        venueId,
        requestId: selectedId,
        limit: 20,
        ...(auditCursor(query) ? { cursor: auditCursor(query) } : {}),
      }),
      caller.admin.listSupportDraftPackages({
        tenantId,
        venueId,
        requestId: selectedId,
        limit: 50,
      }),
      caller.admin.listSupportPackageHandoffs({ tenantId, venueId, requestId: selectedId }),
    ])
    const selected = normalizeRequest(selectedRaw)
    const messages = {
      ...messagePage,
      items: messagePage.items.map((message) => ({
        id: message.id,
        authorKind: message.authorKind,
        visibility: message.visibility,
        body: message.body,
        createdAt: message.createdAt,
        attachments: message.attachments.map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          mediaType: attachment.mediaType,
          byteSize: String(attachment.byteSize),
        })),
      })),
    }
    return (
      <SupportOperationsView
        tenantId={tenantId}
        venueId={venueId}
        requests={requests}
        selected={selected}
        messages={messages}
        audit={audit}
        draftPackages={draftPackages}
        handoffs={handoffs}
      />
    )
  } catch {
    return (
      <section className="rounded-3xl border border-rose-200 bg-white p-8 shadow-sm" role="alert">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-rose-700">
          Support operations
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-pf-deep">
          Support evidence could not be loaded
        </h2>
        <p className="mt-2 text-sm leading-6 text-pf-deep/75">
          Refresh the page or return later. No message, note, status, or artifact change was
          attempted.
        </p>
      </section>
    )
  }
}
