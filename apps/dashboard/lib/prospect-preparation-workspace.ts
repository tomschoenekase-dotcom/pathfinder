import {
  nativeWriterResult,
  type NativeWriterResult,
  type NativeWriterTask,
} from '@pathfinder/api/prospect-writer-contract'
import {
  writingReferenceInput,
  type NativeSalesAction,
  type SalesActionResponse,
  type SalesWorkflowView,
} from '@pathfinder/api/prospect-sales-contract'

/** A refs-only browser workspace over the existing one-venue CRM owners. It is
 * not a campaign, task database, writer, or permission store. All authoritative
 * context and immutable import receipts come from the injected native owner. */
const STORAGE_KEY = 'torchiko.prospect-preparation-workspace.v1'
const MAX_SELECTED = 10
const HASH = /^[a-f0-9]{64}$/u
const SAVED_GUIDE_SOURCE = 'torchiko-writing-reference:v0.2-r001/TORCHIKO-WRITING-REFERENCE.md'

export type WorkspaceReference = { sourceRef: string; sha256: string }
export type WorkspaceWritingReference = NonNullable<
  Extract<NativeSalesAction, { action: 'prepare' }>['input']['writingReference']
>
export type WorkspaceVenue = { id: string; name: string; archivedAt?: Date | string | null }
export type WorkspaceOrganization = {
  id: string
  canonicalName: string
  venues: WorkspaceVenue[]
}
export type PreparationWorkspaceTransport = {
  readOrganization(organizationId: string): Promise<WorkspaceOrganization | null>
  load(venueId: string): Promise<SalesWorkflowView>
  act(action: NativeSalesAction): Promise<SalesActionResponse>
}
export type PreparationWorkspaceStatus =
  | 'LOADING'
  | 'MISSING_ORGANIZATION'
  | 'MISSING_VENUE'
  | 'AMBIGUOUS_VENUE'
  | 'VENUE_CHANGED'
  | 'UNAVAILABLE'
  | 'SUPPRESSED'
  | 'MISSING_ROUTE'
  | 'AMBIGUOUS_THREAD'
  | 'REQUIRES_RESEARCH'
  | 'STALE'
  | 'READABLE'
  | 'PREPARED'
  | 'RESULT_RETAINED'
  | 'PREPARE_UNCERTAIN'
  | 'IMPORT_UNCERTAIN'
export type WorkspaceReceipt = { id: string; draftId: string; taskId: string; replayed: boolean }
export type PreparationWorkspaceItem = {
  organizationId: string
  organizationName: string | null
  venueId: string | null
  venueChoices: { id: string; name: string }[]
  selectedThreadId: string | null
  status: PreparationWorkspaceStatus
  reason: string | null
  view: SalesWorkflowView | null
  guide: WorkspaceReference | null
  writingReference: WorkspaceReference | null
  pendingImport: { taskId: string; resultSha256: string } | null
  receipt: WorkspaceReceipt | null
}
export type PreparationWorkspaceSnapshot = {
  items: PreparationWorkspaceItem[]
  counts: Record<PreparationWorkspaceStatus, number>
  storageAvailable: boolean
}
export type WorkspaceStorage = Pick<Storage, 'getItem' | 'setItem'>

type PendingPrepare = {
  snapshotHash: string
  requestSha256: string
  previousPreparationId: string | null
  selectedThreadId: string | null
  guide: WorkspaceReference | null
  writingReference: WorkspaceReference | null
}
type Saved = {
  schema: 1
  ids: string[]
  venueChoices: Record<string, string>
  threadChoices: Record<string, string>
  guides: Record<string, WorkspaceReference>
  writingReferences: Record<string, WorkspaceReference>
  pendingPrepares: Record<string, PendingPrepare>
  pendingImports: Record<string, { taskId: string; resultSha256: string }>
  receipts: Record<string, WorkspaceReceipt>
}
type InternalItem = PreparationWorkspaceItem & {
  pendingPrepare: PendingPrepare | null
  transientWritingReference: WorkspaceWritingReference | null
  inFlight: boolean
}

function validId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 191 && !/[\r\n\0]/u.test(value)
  )
}
function validReference(value: unknown): value is WorkspaceReference {
  if (!value || typeof value !== 'object') return false
  const ref = value as WorkspaceReference
  return (
    typeof ref.sourceRef === 'string' &&
    ref.sourceRef.length > 0 &&
    ref.sourceRef.length <= 1000 &&
    HASH.test(ref.sha256)
  )
}
function sameReference(left: WorkspaceReference | null, right: WorkspaceReference | null) {
  return left?.sourceRef === right?.sourceRef && left?.sha256 === right?.sha256
}
function preparedReference(view: SalesWorkflowView) {
  const ref = view.preparation?.writingReference
  return ref ? { sourceRef: ref.sourceRef, sha256: ref.sha256 } : null
}
function storedSession(storage: WorkspaceStorage | null): Saved | null {
  if (!storage) return null
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null') as Saved | null
    if (
      !value ||
      value.schema !== 1 ||
      !Array.isArray(value.ids) ||
      value.ids.length > MAX_SELECTED ||
      !value.ids.every(validId) ||
      new Set(value.ids).size !== value.ids.length ||
      !value.venueChoices ||
      !value.threadChoices ||
      !value.guides ||
      !value.writingReferences ||
      !value.pendingPrepares ||
      !value.pendingImports ||
      !value.receipts
    )
      return null
    return value
  } catch {
    return null
  }
}
function storageDefault(): WorkspaceStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}
async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
function sameBinding(left: NativeWriterTask['binding'], right: NativeWriterResult['binding']) {
  const keys = Object.keys(left) as (keyof typeof left)[]
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}
/** These named native conflicts are emitted before the corresponding owner
 * mutation. Import receipt lookup runs first, so an already-committed exact
 * result returns its immutable receipt instead of any of these conflicts. */
function knownPrecommitRejection(
  error: unknown,
  action: 'prepare' | 'import',
): 'STALE_GUIDE' | 'STALE_SOURCE' | 'MISSING_PREPARATION' | null {
  if (!error || typeof error !== 'object') return null
  const candidate = error as { data?: { code?: unknown }; message?: unknown }
  if (candidate.data?.code !== 'CONFLICT' || typeof candidate.message !== 'string') return null
  if (
    candidate.message.startsWith('STALE_SELECTED_WRITING_GUIDE:') ||
    candidate.message.startsWith('SELECTED_WRITING_GUIDE_UNAVAILABLE:')
  )
    return 'STALE_GUIDE'
  if (candidate.message.startsWith('STALE_NATIVE_SNAPSHOT:')) return 'STALE_SOURCE'
  if (action === 'import' && candidate.message.startsWith('WRONG_WRITER_PREPARATION:'))
    return 'MISSING_PREPARATION'
  return null
}
function statusCounts(items: readonly InternalItem[]): Record<PreparationWorkspaceStatus, number> {
  const counts = Object.fromEntries(
    [
      'LOADING',
      'MISSING_ORGANIZATION',
      'MISSING_VENUE',
      'AMBIGUOUS_VENUE',
      'VENUE_CHANGED',
      'UNAVAILABLE',
      'SUPPRESSED',
      'MISSING_ROUTE',
      'AMBIGUOUS_THREAD',
      'REQUIRES_RESEARCH',
      'STALE',
      'READABLE',
      'PREPARED',
      'RESULT_RETAINED',
      'PREPARE_UNCERTAIN',
      'IMPORT_UNCERTAIN',
    ].map((status) => [status, 0]),
  ) as Record<PreparationWorkspaceStatus, number>
  for (const item of items) counts[item.status]++
  return counts
}

export function createProspectPreparationWorkspace(input: {
  transport: PreparationWorkspaceTransport
  storage?: WorkspaceStorage | null
}) {
  const { transport } = input
  const storage = input.storage === undefined ? storageDefault() : input.storage
  let storageAvailable = Boolean(storage)
  const rows = new Map<string, InternalItem>()
  const activeActions = new Set<string>()
  const readVersions = new WeakMap<InternalItem, symbol>()
  const listeners = new Set<() => void>()
  let selectedIds: string[] = []
  const emit = () => {
    for (const listener of listeners) listener()
  }
  const item = (id: string) => {
    const found = rows.get(id)
    if (!found) throw new Error('Organization is not in this explicitly selected workspace')
    return found
  }
  const publicItem = (row: InternalItem): PreparationWorkspaceItem => ({
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    venueId: row.venueId,
    venueChoices: [...row.venueChoices],
    selectedThreadId: row.selectedThreadId,
    status: row.status,
    reason: row.reason,
    view: row.view,
    guide: row.guide,
    writingReference: row.writingReference,
    pendingImport: row.pendingImport,
    receipt: row.receipt,
  })
  const snapshot = (): PreparationWorkspaceSnapshot => {
    const selected = selectedIds.map(item)
    return { items: selected.map(publicItem), counts: statusCounts(selected), storageAvailable }
  }
  const persist = () => {
    if (!storage) return
    const saved: Saved = {
      schema: 1,
      ids: selectedIds,
      venueChoices: {},
      threadChoices: {},
      guides: {},
      writingReferences: {},
      pendingPrepares: {},
      pendingImports: {},
      receipts: {},
    }
    for (const row of rows.values()) {
      if (row.venueId) saved.venueChoices[row.organizationId] = row.venueId
      if (row.selectedThreadId) saved.threadChoices[row.organizationId] = row.selectedThreadId
      if (row.guide) saved.guides[row.organizationId] = row.guide
      if (row.writingReference) saved.writingReferences[row.organizationId] = row.writingReference
      if (row.pendingPrepare) saved.pendingPrepares[row.organizationId] = row.pendingPrepare
      if (row.pendingImport) saved.pendingImports[row.organizationId] = row.pendingImport
      if (row.receipt) saved.receipts[row.organizationId] = row.receipt
    }
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(saved))
      storageAvailable = true
    } catch {
      storageAvailable = false
    }
  }
  const newItem = (organizationId: string): InternalItem => ({
    organizationId,
    organizationName: null,
    venueId: null,
    venueChoices: [],
    selectedThreadId: null,
    status: 'LOADING',
    reason: null,
    view: null,
    guide: null,
    writingReference: null,
    pendingImport: null,
    receipt: null,
    pendingPrepare: null,
    transientWritingReference: null,
    inFlight: false,
  })
  const setStatus = (
    row: InternalItem,
    status: PreparationWorkspaceStatus,
    reason: string | null,
  ) => {
    row.status = status
    row.reason = reason
    emit()
  }
  const classify = (row: InternalItem) => {
    const view = row.view
    if (!view) return
    if (view.suppression.blocked)
      return setStatus(
        row,
        'SUPPRESSED',
        view.suppression.reasons.join('; ') || 'Native suppression holds preparation',
      )
    if (!view.routing?.value || !view.routing.nativeContactId)
      return setStatus(
        row,
        'MISSING_ROUTE',
        'No exact native contact and public route are selected',
      )
    if (row.pendingImport)
      return setStatus(
        row,
        'IMPORT_UNCERTAIN',
        'Keep and explicitly retry the same exact result file to recover its immutable receipt',
      )
    if (row.pendingPrepare)
      return setStatus(
        row,
        'PREPARE_UNCERTAIN',
        'Preparation response was uncertain; reload and explicitly retry the same request only',
      )
    if (
      view.preparation?.stale ||
      (view.preparation && !view.writerTask && view.writerHold) ||
      (view.preparation &&
        row.writingReference &&
        !sameReference(row.writingReference, preparedReference(view))) ||
      (view.preparation && row.guide && !sameReference(row.guide, preparedReference(view)))
    )
      return setStatus(
        row,
        'STALE',
        'Reference, guide, reply, route, or source changed; prepare explicitly from current owner state',
      )
    if (
      row.selectedThreadId &&
      !view.threadCandidates.some((candidate) => candidate.id === row.selectedThreadId)
    )
      return setStatus(
        row,
        'STALE',
        'The selected native thread is no longer in the current bounded review',
      )
    if (
      row.selectedThreadId &&
      !view.threadCandidates.some(
        (candidate) => candidate.id === row.selectedThreadId && candidate.sourceComplete,
      )
    )
      return setStatus(
        row,
        'REQUIRES_RESEARCH',
        'The selected native thread has incomplete source content',
      )
    if (view.threadCandidates.length > 1 && !row.selectedThreadId)
      return setStatus(row, 'AMBIGUOUS_THREAD', 'Select one exact native thread before preparing')
    if (
      row.receipt ||
      (view.draft?.writerAttribution && view.draft.preparationId === view.preparation?.id)
    )
      return setStatus(
        row,
        'RESULT_RETAINED',
        'An attributed result is retained for review; no send approval is implied',
      )
    if (
      view.preparation &&
      view.writerTask &&
      view.writerTask.binding.preparationId === view.preparation.id &&
      view.writerTask.binding.nativeSnapshotHash === view.snapshotHash
    )
      return setStatus(row, 'PREPARED', null)
    if (
      !view.gate.canPrepare &&
      !(
        row.selectedThreadId &&
        view.threadCandidates.some(
          (candidate) => candidate.id === row.selectedThreadId && candidate.sourceComplete,
        )
      )
    )
      return setStatus(
        row,
        'REQUIRES_RESEARCH',
        view.blocker ||
          view.gate.humanQuestions.join('; ') ||
          'Current native evidence does not permit preparation',
      )
    if (view.blocker) return setStatus(row, 'REQUIRES_RESEARCH', view.blocker)
    return setStatus(row, 'READABLE', null)
  }

  async function refresh(organizationId: string) {
    if (activeActions.has(organizationId))
      throw new Error('This record already has an action in progress')
    return refreshOwned(organizationId)
  }
  async function refreshOwned(organizationId: string) {
    const row = item(organizationId)
    if (row.inFlight) throw new Error('This record already has an action in progress')
    const version = Symbol('native-read')
    readVersions.set(row, version)
    const current = () =>
      rows.get(organizationId) === row &&
      selectedIds.includes(organizationId) &&
      readVersions.get(row) === version
    setStatus(row, 'LOADING', null)
    try {
      const organization = await transport.readOrganization(organizationId)
      if (!current()) return publicItem(row)
      if (!organization || organization.id !== organizationId) {
        row.view = null
        row.organizationName = null
        row.venueChoices = []
        setStatus(
          row,
          'MISSING_ORGANIZATION',
          'The exact organization no longer exists in native CRM',
        )
        return publicItem(row)
      }
      row.organizationName = organization.canonicalName
      const active = organization.venues.filter((venue) => !venue.archivedAt)
      row.venueChoices = active.map(({ id, name }) => ({ id, name }))
      if (!row.venueId && active.length === 1) row.venueId = active[0]!.id
      if (!row.venueId) {
        row.view = null
        setStatus(
          row,
          active.length ? 'AMBIGUOUS_VENUE' : 'MISSING_VENUE',
          active.length
            ? 'Select one exact native venue; the organization has multiple active venues'
            : 'No active native venue exists for this organization',
        )
        return publicItem(row)
      }
      if (!active.some((venue) => venue.id === row.venueId)) {
        row.view = null
        setStatus(
          row,
          'VENUE_CHANGED',
          'The previously selected native venue is no longer active; choose explicitly',
        )
        return publicItem(row)
      }
      const view = await transport.load(row.venueId)
      if (!current()) return publicItem(row)
      if (
        view.venueId !== row.venueId ||
        view.organizationId !== organizationId ||
        view.SEND_AUTHORIZED !== false ||
        view.senderAvailable !== false
      )
        throw new Error(
          'Native workflow returned a different venue, organization, or send authority',
        )
      row.view = view
      if (!row.guide && !row.writingReference && preparedReference(view))
        row.writingReference = preparedReference(view)
      if (
        row.pendingPrepare &&
        view.snapshotHash === row.pendingPrepare.snapshotHash &&
        view.preparation &&
        !view.preparation.stale &&
        (row.pendingPrepare.previousPreparationId !== view.preparation.id ||
          view.writerTask?.binding.preparationId === view.preparation.id) &&
        sameReference(
          row.pendingPrepare.guide ?? row.pendingPrepare.writingReference,
          preparedReference(view),
        ) &&
        (!row.pendingPrepare.selectedThreadId ||
          view.correspondence?.threadId === row.pendingPrepare.selectedThreadId)
      ) {
        row.pendingPrepare = null
      }
      classify(row)
      return publicItem(row)
    } catch (error) {
      if (!current()) return publicItem(row)
      row.view = null
      setStatus(
        row,
        'UNAVAILABLE',
        error instanceof Error ? error.message : 'Native owner unavailable',
      )
      return publicItem(row)
    } finally {
      if (current()) persist()
    }
  }

  async function loadSelection(ids: readonly string[], saved: Saved | null) {
    if (activeActions.size)
      throw new Error('Wait for the current preparation or import before changing this selection')
    const distinct = [...new Set(ids)]
    if (distinct.length > MAX_SELECTED || !distinct.every(validId))
      throw new Error('Select at most ten exact native organization IDs')
    if (
      !saved &&
      selectedIds.some(
        (id) =>
          !distinct.includes(id) && (rows.get(id)?.pendingPrepare || rows.get(id)?.pendingImport),
      )
    )
      throw new Error(
        'Recover uncertain selected work before removing it from this browser workspace',
      )
    selectedIds = distinct
    for (const id of distinct) {
      let row = rows.get(id)
      if (!row) {
        row = newItem(id)
        rows.set(id, row)
      }
      if (saved) {
        row.venueId = validId(saved.venueChoices[id]) ? saved.venueChoices[id] : null
        row.selectedThreadId = validId(saved.threadChoices[id]) ? saved.threadChoices[id] : null
        row.guide = validReference(saved.guides[id]) ? saved.guides[id] : null
        row.writingReference = validReference(saved.writingReferences[id])
          ? saved.writingReferences[id]
          : null
        const pending = saved.pendingPrepares[id]
        row.pendingPrepare =
          pending && HASH.test(pending.snapshotHash) && HASH.test(pending.requestSha256)
            ? pending
            : null
        const pendingImport = saved.pendingImports[id]
        row.pendingImport =
          pendingImport && validId(pendingImport.taskId) && HASH.test(pendingImport.resultSha256)
            ? pendingImport
            : null
        const receipt = saved.receipts[id]
        row.receipt =
          receipt && validId(receipt.id) && validId(receipt.draftId) && validId(receipt.taskId)
            ? receipt
            : null
      }
    }
    for (const id of [...rows.keys()]) if (!distinct.includes(id)) rows.delete(id)
    persist()
    emit()
    // Reads are independent and selection is bounded to ten. A slow or held
    // first record must not hide successful peers while its owner is pending.
    await Promise.all(distinct.map((id) => refresh(id)))
    return snapshot()
  }

  async function selectOrganizations(ids: readonly string[]) {
    return loadSelection(ids, null)
  }
  async function reopen() {
    const saved = storedSession(storage)
    return loadSelection(saved?.ids ?? [], saved)
  }
  async function chooseVenue(organizationId: string, venueId: string) {
    if (activeActions.has(organizationId))
      throw new Error('This record already has an action in progress')
    const row = item(organizationId)
    if (row.pendingImport || row.pendingPrepare || row.receipt)
      throw new Error(
        'Recover this venue’s exact preparation or result before changing its selection',
      )
    if (!row.venueChoices.some((venue) => venue.id === venueId))
      throw new Error('Select a venue from this organization’s current native choices')
    row.venueId = venueId
    row.selectedThreadId = null
    row.view = null
    row.pendingPrepare = null
    row.pendingImport = null
    row.receipt = null
    persist()
    return refresh(organizationId)
  }
  function chooseThread(organizationId: string, threadId: string) {
    if (activeActions.has(organizationId))
      throw new Error('This record already has an action in progress')
    const row = item(organizationId)
    if (row.pendingPrepare || row.pendingImport)
      throw new Error('Recover the exact pending action before changing its selected thread')
    if (!row.view?.threadCandidates.some((candidate) => candidate.id === threadId))
      throw new Error('Select one current native thread for this venue')
    row.selectedThreadId = threadId
    persist()
    classify(row)
    return publicItem(row)
  }
  function setGuide(organizationId: string, guide: WorkspaceReference | null) {
    if (activeActions.has(organizationId))
      throw new Error('This record already has an action in progress')
    const row = item(organizationId)
    if (row.pendingPrepare || row.pendingImport)
      throw new Error('Recover the exact pending action before changing its selected guide')
    if (guide && (!validReference(guide) || guide.sourceRef !== SAVED_GUIDE_SOURCE))
      throw new Error('Selected guide needs the exact saved Torchiko source reference and SHA-256')
    row.guide = guide
    if (guide) {
      row.writingReference = null
      row.transientWritingReference = null
    }
    persist()
    classify(row)
    return publicItem(row)
  }
  async function setWritingReference(
    organizationId: string,
    reference: WorkspaceWritingReference | null,
  ) {
    if (activeActions.has(organizationId))
      throw new Error('This record already has an action in progress')
    activeActions.add(organizationId)
    try {
      return await setWritingReferenceOwned(organizationId, reference)
    } finally {
      activeActions.delete(organizationId)
    }
  }
  async function setWritingReferenceOwned(
    organizationId: string,
    reference: WorkspaceWritingReference | null,
  ) {
    const row = item(organizationId)
    if (row.pendingImport)
      throw new Error('Recover the exact pending import before changing its writing reference')
    if (reference) {
      const parsed = writingReferenceInput.parse(reference)
      if ((await sha256(parsed.text)) !== parsed.sha256)
        throw new Error('Writing reference bytes do not match their declared SHA-256')
      if (
        row.pendingPrepare &&
        !sameReference(row.pendingPrepare.writingReference, {
          sourceRef: parsed.sourceRef,
          sha256: parsed.sha256,
        })
      )
        throw new Error('Recover the uncertain preparation with the same exact writing reference')
      row.transientWritingReference = parsed
      row.writingReference = { sourceRef: parsed.sourceRef, sha256: parsed.sha256 }
      row.guide = null
    } else {
      if (row.pendingPrepare?.writingReference)
        throw new Error(
          'Reselect the exact writing reference before retrying uncertain preparation',
        )
      row.transientWritingReference = null
      row.writingReference = null
    }
    persist()
    classify(row)
    return publicItem(row)
  }
  async function prepare(
    organizationId: string,
    options: {
      answerText?: string
      selectedThreadId?: string
    } = {},
  ) {
    if (activeActions.has(organizationId))
      throw new Error('This record already has an action in progress')
    activeActions.add(organizationId)
    try {
      return await prepareOwned(organizationId, options)
    } finally {
      activeActions.delete(organizationId)
    }
  }
  async function prepareOwned(
    organizationId: string,
    options: { answerText?: string; selectedThreadId?: string },
  ) {
    const row = item(organizationId)
    if (row.inFlight) throw new Error('This record already has an action in progress')
    await refreshOwned(organizationId)
    const view = row.view
    if (
      !view ||
      !row.venueId ||
      [
        'SUPPRESSED',
        'MISSING_ROUTE',
        'AMBIGUOUS_VENUE',
        'MISSING_VENUE',
        'VENUE_CHANGED',
        'UNAVAILABLE',
        'MISSING_ORGANIZATION',
      ].includes(row.status)
    )
      throw new Error(row.reason ?? 'Current native venue cannot be prepared')
    if (
      row.status === 'PREPARED' &&
      !row.pendingPrepare &&
      !options.answerText &&
      !options.selectedThreadId
    )
      return publicItem(row)
    const selectedThreadId = options.selectedThreadId ?? row.selectedThreadId ?? undefined
    if (view.threadCandidates.length > 1 && !selectedThreadId)
      throw new Error('Select one exact native thread before preparing')
    if (
      selectedThreadId &&
      !view.threadCandidates.some(
        (candidate) => candidate.id === selectedThreadId && candidate.sourceComplete,
      )
    )
      throw new Error('Selected native thread is absent or source-incomplete')
    if (!view.gate.canPrepare && !selectedThreadId)
      throw new Error(view.blocker ?? 'Native research gate holds preparation')
    if (
      (view.correspondence?.latestInbound || selectedThreadId) &&
      (!options.answerText || options.answerText.trim().length < 12)
    )
      throw new Error('Supply a bounded answer to the exact selected inbound point')
    const ownerReference = view.preparation?.writingReference
    const reference =
      row.transientWritingReference ??
      (ownerReference && sameReference(row.writingReference, preparedReference(view))
        ? ownerReference
        : null)
    if (row.writingReference && !reference)
      throw new Error(
        'Reselect the exact writing reference bytes after reopening; only its hash was retained',
      )
    const request = {
      venueId: row.venueId,
      expectedSnapshotHash: view.snapshotHash,
      ...(selectedThreadId ? { selectedThreadId } : {}),
      ...(options.answerText ? { answerText: options.answerText } : {}),
    }
    const requestSha256 = await sha256(
      JSON.stringify({
        ...request,
        guide: row.guide,
        writingReference: row.writingReference,
      }),
    )
    if (
      row.pendingPrepare &&
      (row.pendingPrepare.requestSha256 !== requestSha256 ||
        row.pendingPrepare.snapshotHash !== view.snapshotHash)
    )
      throw new Error(
        'An uncertain preparation has a different source or input; recover it before changing the request',
      )
    row.pendingPrepare = {
      snapshotHash: view.snapshotHash,
      requestSha256,
      previousPreparationId: view.preparation?.id ?? null,
      selectedThreadId: selectedThreadId ?? null,
      guide: row.guide,
      writingReference: row.writingReference,
    }
    if (selectedThreadId) row.selectedThreadId = selectedThreadId
    row.inFlight = true
    persist()
    setStatus(row, 'LOADING', 'Submitting one explicit native preparation')
    try {
      const response = await transport.act({
        action: 'prepare',
        input: {
          ...request,
          ...(row.guide
            ? {
                savedWritingGuide: 'torchiko-v0.2' as const,
                expectedWritingGuideSha256: row.guide.sha256,
              }
            : reference
              ? { writingReference: reference }
              : {}),
        },
      })
      if (
        'schema' in response ||
        response.venueId !== row.venueId ||
        response.SEND_AUTHORIZED !== false ||
        response.senderAvailable !== false ||
        !response.preparation?.id
      )
        throw new Error('Native preparation did not return this exact no-send venue')
      row.view = response
      row.pendingPrepare = null
      classify(row)
      return publicItem(row)
    } catch (error) {
      const known = knownPrecommitRejection(error, 'prepare')
      if (known) {
        row.pendingPrepare = null
        setStatus(
          row,
          'STALE',
          `${error instanceof Error ? error.message : 'Selected source changed'}. Reload the current owner and explicitly choose the new guide or source before preparing.`,
        )
      } else {
        setStatus(
          row,
          'PREPARE_UNCERTAIN',
          `${error instanceof Error ? error.message : 'Preparation response unavailable'}. Reload owner state and explicitly retry only the same request.`,
        )
      }
      return publicItem(row)
    } finally {
      row.inFlight = false
      persist()
    }
  }
  async function currentWriterTask(organizationId: string): Promise<NativeWriterTask> {
    if (activeActions.has(organizationId))
      throw new Error('This record already has an action in progress')
    activeActions.add(organizationId)
    try {
      return await currentWriterTaskOwned(organizationId)
    } finally {
      activeActions.delete(organizationId)
    }
  }
  async function currentWriterTaskOwned(organizationId: string): Promise<NativeWriterTask> {
    const row = item(organizationId)
    await refreshOwned(organizationId)
    if (rows.get(organizationId) !== row || !selectedIds.includes(organizationId))
      throw new Error('Organization is no longer selected for task export')
    const view = row.view
    const task = view?.writerTask
    if (
      !view ||
      !['PREPARED', 'RESULT_RETAINED'].includes(row.status) ||
      !task ||
      task.binding.venueId !== row.venueId ||
      task.binding.nativeSnapshotHash !== view.snapshotHash ||
      task.binding.preparationId !== view.preparation?.id
    )
      throw new Error(
        'Current source-bound writer task is unavailable; inspect this venue before exporting',
      )
    return task
  }
  async function importWriterResult(organizationId: string, raw: unknown) {
    if (activeActions.has(organizationId))
      throw new Error('This record already has an action in progress')
    activeActions.add(organizationId)
    try {
      return await importWriterResultOwned(organizationId, raw)
    } finally {
      activeActions.delete(organizationId)
    }
  }
  async function importWriterResultOwned(organizationId: string, raw: unknown) {
    const row = item(organizationId)
    if (row.inFlight) throw new Error('This record already has an action in progress')
    const result = nativeWriterResult.parse(raw)
    const resultSha256 = await sha256(JSON.stringify(result))
    if (result.binding.venueId !== row.venueId)
      throw new Error('This result belongs to a different exact native venue')
    if (
      row.pendingImport &&
      (row.pendingImport.taskId !== result.taskId ||
        row.pendingImport.resultSha256 !== resultSha256)
    )
      throw new Error('Recover the uncertain import with the same exact result file')
    if (!row.pendingImport) {
      await refreshOwned(organizationId)
      const task = row.view?.writerTask
      if (
        !task ||
        row.status !== 'PREPARED' ||
        task.taskId !== result.taskId ||
        !sameBinding(task.binding, result.binding)
      )
        throw new Error('Result does not match the current exact native writer task')
    }
    row.pendingImport = { taskId: result.taskId, resultSha256 }
    row.inFlight = true
    persist()
    setStatus(row, 'LOADING', 'Submitting one exact model result to native CRM')
    try {
      const response = await transport.act({
        action: 'importWriterResult',
        input: {
          venueId: result.binding.venueId,
          expectedSnapshotHash: result.binding.nativeSnapshotHash,
          result,
        },
      })
      const receipt = response.writerImportReceipt
      if (
        response.venueId !== row.venueId ||
        !receipt?.id ||
        !receipt.draftId ||
        response.SEND_AUTHORIZED !== false ||
        response.senderAvailable !== false
      )
        throw new Error('Import response omitted its immutable no-send receipt')
      row.receipt = {
        id: receipt.id,
        draftId: receipt.draftId,
        taskId: result.taskId,
        replayed: receipt.replayed,
      }
      row.pendingImport = null
      row.view = 'schema' in response ? null : response
      setStatus(
        row,
        'RESULT_RETAINED',
        'Exact result receipt retained; inspect current native draft and review state',
      )
      return publicItem(row)
    } catch (error) {
      const known = knownPrecommitRejection(error, 'import')
      if (known) {
        row.pendingImport = null
        setStatus(
          row,
          'STALE',
          `${error instanceof Error ? error.message : 'Native source changed'}. This exact result was not imported by this attempt; inspect current owner state before a new preparation.`,
        )
      } else {
        setStatus(
          row,
          'IMPORT_UNCERTAIN',
          `${error instanceof Error ? error.message : 'Import response unavailable'}. Keep and explicitly retry the same exact result file; no new model output is needed.`,
        )
      }
      return publicItem(row)
    } finally {
      row.inFlight = false
      persist()
    }
  }

  return {
    snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    selectOrganizations,
    reopen,
    refresh,
    chooseVenue,
    chooseThread,
    setGuide,
    setWritingReference,
    prepare,
    currentWriterTask,
    importWriterResult,
  }
}
