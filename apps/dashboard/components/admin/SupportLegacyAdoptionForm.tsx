'use client'

import { FormEvent, useEffect, useRef, useState } from 'react'

import type { CreateLegacyKnowledgeAdoptionDraftInput } from '@pathfinder/contracts/legacy-knowledge-adoption'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

const REQUEST_TIMEOUT_MS = 15_000
type Kind = 'POLICY' | 'ITEM' | 'SERVICE' | 'EVENT' | 'OPERATIONAL_FACT'
type Audience = 'PUBLIC' | 'CLIENT' | 'OPERATOR'
type Desired = { title: string; category: string; content: string; isEnabled: boolean }

type Props = {
  tenantId: string
  venueId: string
  proposalId: string
  proposalUpdatedAt: Date | string
  expectedPreviewHash: string
  relation: 'CORRECTS' | 'SUPERSEDES'
  desired: Desired
  onFrozenChange?: (frozen: boolean) => void
}

type Prepared = {
  tenantId: string
  venueId: string
  proposalId: string
  legacyKnowledgeEntryId: string
  expectedProposalUpdatedAt: string
  expectedPreviewHash: string
  expectedLegacyUpdatedAt: string
  expectedLegacySnapshotHash: string
  relation: 'CORRECTS' | 'SUPERSEDES'
  desired: Desired
}

type FrozenInput = Prepared & {
  draft: CreateLegacyKnowledgeAdoptionDraftInput['draft']
}

function codeOf(error: unknown) {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  return data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
    ? data.code
    : null
}

const iso = (value: Date | string) => new Date(value).toISOString()

export function SupportLegacyAdoptionForm(props: Props) {
  const client = useTRPCClient()
  const [preparedState, setPrepared] = useState<{ scope: string; value: Prepared } | null>(null)
  const [kind, setKind] = useState<Kind | ''>('')
  const [audience, setAudience] = useState<Audience>('PUBLIC')
  const [itemType, setItemType] = useState('')
  const [serviceAvailability, setServiceAvailability] = useState('')
  const [eventStartsAt, setEventStartsAt] = useState('')
  const [eventEndsAt, setEventEndsAt] = useState('')
  const [pending, setPending] = useState<'PREPARE' | 'CREATE' | null>(null)
  const [unknown, setUnknown] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [receiptState, setReceipt] = useState<{
    scope: string
    value: { moduleId: string; revisionId: string; version: number }
  } | null>(null)
  const mounted = useRef(false)
  const generation = useRef(0)
  const running = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const frozen = useRef<FrozenInput | null>(null)
  const onFrozenChange = useRef(props.onFrozenChange)
  onFrozenChange.current = props.onFrozenChange
  const scope = JSON.stringify([
    props.tenantId,
    props.venueId,
    props.proposalId,
    iso(props.proposalUpdatedAt),
    props.expectedPreviewHash,
    props.relation,
    props.desired,
  ])
  const currentScope = useRef(scope)
  currentScope.current = scope
  const prepared = preparedState?.scope === scope ? preparedState.value : null
  const receipt = receiptState?.scope === scope ? receiptState.value : null

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      controller.current?.abort()
      running.current = false
      onFrozenChange.current?.(false)
    }
  }, [])

  useEffect(() => {
    generation.current += 1
    controller.current?.abort()
    controller.current = null
    running.current = false
    frozen.current = null
    onFrozenChange.current?.(false)
    setPrepared(null)
    setKind('')
    setAudience('PUBLIC')
    setItemType('')
    setServiceAvailability('')
    setEventStartsAt('')
    setEventEndsAt('')
    setPending(null)
    setUnknown(false)
    setFeedback(null)
    setReceipt(null)
  }, [scope])

  async function prepare() {
    if (running.current || !props.desired.isEnabled) return
    running.current = true
    const startedGeneration = generation.current
    const startedScope = scope
    const requestController = new AbortController()
    controller.current = requestController
    setPending('PREPARE')
    setFeedback(null)
    try {
      const result = await runBoundedClientRequest({
        parentSignal: requestController.signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
        request: (signal) =>
          client.admin.prepareLegacyKnowledgeAdoptionDraft.query(
            {
              tenantId: props.tenantId,
              venueId: props.venueId,
              proposalId: props.proposalId,
              expectedUpdatedAt: new Date(props.proposalUpdatedAt),
              relation: props.relation,
              desired: props.desired,
            },
            { signal },
          ),
      })
      if (
        !mounted.current ||
        generation.current !== startedGeneration ||
        currentScope.current !== startedScope
      )
        return
      if (result.expectedPreviewHash !== props.expectedPreviewHash) {
        setFeedback('The semantic preview changed. Recompute it before preparing this draft.')
        return
      }
      setPrepared({ scope: startedScope, value: result })
      setFeedback('Legacy source confirmed. Choose the private draft content type.')
    } catch {
      if (
        !mounted.current ||
        generation.current !== startedGeneration ||
        currentScope.current !== startedScope
      )
        return
      setFeedback('Preparation could not be confirmed. Try preparing again from current data.')
    } finally {
      if (
        controller.current === requestController &&
        generation.current === startedGeneration &&
        currentScope.current === startedScope
      ) {
        controller.current = null
        running.current = false
        if (mounted.current) setPending(null)
      }
    }
  }

  function payload(): CreateLegacyKnowledgeAdoptionDraftInput['draft']['payload'] | null {
    if (kind === 'POLICY')
      return { kind, title: props.desired.title, rule: props.desired.content, appliesTo: [] }
    if (kind === 'ITEM' && itemType.trim())
      return {
        kind,
        name: props.desired.title,
        description: props.desired.content,
        itemType: itemType.trim(),
      }
    if (kind === 'SERVICE')
      return {
        kind,
        name: props.desired.title,
        description: props.desired.content,
        ...(serviceAvailability.trim() ? { availability: serviceAvailability.trim() } : {}),
      }
    if (kind === 'EVENT' && eventStartsAt) {
      const startsAtMs = Date.parse(eventStartsAt)
      const endsAtMs = eventEndsAt ? Date.parse(eventEndsAt) : null
      if (
        !Number.isFinite(startsAtMs) ||
        (endsAtMs !== null && (!Number.isFinite(endsAtMs) || endsAtMs <= startsAtMs))
      )
        return null
      const startsAt = new Date(startsAtMs).toISOString()
      const endsAt = endsAtMs === null ? undefined : new Date(endsAtMs).toISOString()
      return {
        kind,
        name: props.desired.title,
        description: props.desired.content,
        startsAt,
        ...(endsAt ? { endsAt } : {}),
      }
    }
    if (kind === 'OPERATIONAL_FACT')
      return { kind, label: props.desired.title, value: props.desired.content }
    return null
  }

  async function create(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (running.current || !prepared) return
    let input = frozen.current
    if (!input) {
      const exactPayload = payload()
      if (!exactPayload) return
      input = {
        ...prepared,
        draft: { audience, evidence: [], payload: exactPayload },
      }
      frozen.current = input
      onFrozenChange.current?.(true)
    }
    running.current = true
    const startedGeneration = generation.current
    const startedScope = scope
    const requestController = new AbortController()
    controller.current = requestController
    setPending('CREATE')
    setFeedback(null)
    try {
      const result = await runBoundedClientRequest({
        parentSignal: requestController.signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
        request: (signal) =>
          client.admin.createSupportLegacyKnowledgeAdoptionDraft.mutate(input, { signal }),
      })
      if (
        !mounted.current ||
        generation.current !== startedGeneration ||
        currentScope.current !== startedScope
      )
        return
      frozen.current = null
      onFrozenChange.current?.(false)
      setUnknown(false)
      setReceipt({ scope: startedScope, value: result })
      setFeedback('Private draft created. Publication still requires a separate explicit action.')
    } catch (error) {
      if (
        !mounted.current ||
        generation.current !== startedGeneration ||
        currentScope.current !== startedScope
      )
        return
      if (
        [
          'BAD_REQUEST',
          'UNAUTHORIZED',
          'FORBIDDEN',
          'CONFLICT',
          'NOT_FOUND',
          'PRECONDITION_FAILED',
        ].includes(codeOf(error) ?? '')
      ) {
        frozen.current = null
        onFrozenChange.current?.(false)
        setUnknown(false)
        setPrepared(null)
        setFeedback('The source or proposal changed. Prepare again from current data.')
      } else {
        setUnknown(true)
        setFeedback('The outcome is unknown. Retry the exact same private draft request.')
      }
    } finally {
      if (
        controller.current === requestController &&
        generation.current === startedGeneration &&
        currentScope.current === startedScope
      ) {
        controller.current = null
        running.current = false
        if (mounted.current) setPending(null)
      }
    }
  }

  const exactPayload = payload()
  const frozenControls = pending === 'CREATE' || unknown || Boolean(frozen.current)

  return (
    <section className="border-t border-pf-light pt-5" aria-label="Legacy knowledge adoption">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-pf-deep">Prepare a private content draft</h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-pf-deep/70">
            Create a private draft from this approved guidance. Publishing remains a separate step.
          </p>
        </div>
        {!prepared && !receipt ? (
          <button
            type="button"
            onClick={() => void prepare()}
            disabled={pending !== null || !props.desired.isEnabled}
            className="min-h-11 border border-pf-primary px-4 py-2 text-sm font-semibold text-pf-primary disabled:opacity-50"
          >
            {pending === 'PREPARE' ? 'Preparing…' : 'Prepare private draft'}
          </button>
        ) : null}
      </div>

      {!props.desired.isEnabled ? (
        <p className="mt-3 text-sm text-amber-800">
          Disabled guidance cannot be adopted. Disabling guidance requires a separate retirement
          review.
        </p>
      ) : null}

      {prepared && !receipt ? (
        <form onSubmit={(event) => void create(event)} className="mt-5 space-y-4">
          <fieldset disabled={frozenControls} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-semibold text-pf-deep">
                Content type
                <select
                  value={kind}
                  onChange={(event) => setKind(event.target.value as Kind | '')}
                  className="mt-1 min-h-11 w-full border border-pf-light bg-white px-3"
                  required
                >
                  <option value="">Choose a content type</option>
                  <option value="POLICY">Policy</option>
                  <option value="ITEM">Item</option>
                  <option value="SERVICE">Service</option>
                  <option value="EVENT">Event</option>
                  <option value="OPERATIONAL_FACT">Operational fact</option>
                </select>
              </label>
              <label className="text-sm font-semibold text-pf-deep">
                Audience
                <select
                  value={audience}
                  onChange={(event) => setAudience(event.target.value as Audience)}
                  className="mt-1 min-h-11 w-full border border-pf-light bg-white px-3"
                >
                  <option value="PUBLIC">Public</option>
                  <option value="CLIENT">Client team</option>
                  <option value="OPERATOR">Operators</option>
                </select>
              </label>
            </div>

            <dl className="grid gap-3 border-l-2 border-pf-light pl-4 text-sm sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="font-semibold text-pf-deep">Approved title</dt>
                <dd className="break-words text-pf-deep/70">{props.desired.title}</dd>
              </div>
              <div className="min-w-0 sm:col-span-2">
                <dt className="font-semibold text-pf-deep">Approved wording</dt>
                <dd className="whitespace-pre-wrap break-words text-pf-deep/70">
                  {props.desired.content}
                </dd>
              </div>
            </dl>

            {kind === 'ITEM' ? (
              <label className="block text-sm font-semibold text-pf-deep">
                Item type
                <input
                  value={itemType}
                  onChange={(event) => setItemType(event.target.value)}
                  required
                  maxLength={100}
                  className="mt-1 min-h-11 w-full border border-pf-light px-3"
                />
              </label>
            ) : null}
            {kind === 'SERVICE' ? (
              <label className="block text-sm font-semibold text-pf-deep">
                Availability (optional)
                <input
                  value={serviceAvailability}
                  onChange={(event) => setServiceAvailability(event.target.value)}
                  maxLength={2000}
                  className="mt-1 min-h-11 w-full border border-pf-light px-3"
                />
              </label>
            ) : null}
            {kind === 'EVENT' ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-sm font-semibold text-pf-deep">
                  Event starts (your local time)
                  <input
                    type="datetime-local"
                    value={eventStartsAt}
                    onChange={(event) => setEventStartsAt(event.target.value)}
                    required
                    className="mt-1 min-h-11 w-full border border-pf-light px-3"
                  />
                </label>
                <label className="text-sm font-semibold text-pf-deep">
                  Event ends (optional, your local time)
                  <input
                    type="datetime-local"
                    value={eventEndsAt}
                    onChange={(event) => setEventEndsAt(event.target.value)}
                    className="mt-1 min-h-11 w-full border border-pf-light px-3"
                  />
                </label>
              </div>
            ) : null}
          </fieldset>

          <button
            type="submit"
            disabled={!exactPayload || pending !== null || receipt !== null}
            className="min-h-11 bg-pf-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {pending === 'CREATE'
              ? 'Creating private draft…'
              : unknown
                ? 'Retry exact private draft'
                : 'Create private draft'}
          </button>
        </form>
      ) : null}

      {feedback ? (
        <p role="status" className="mt-3 text-sm text-pf-deep/75">
          {feedback}
        </p>
      ) : null}
      {receipt ? (
        <div className="mt-4 border-l-2 border-emerald-600 pl-4 text-sm text-pf-deep">
          <p className="font-semibold">Private draft ready for separate publication review</p>
          <p className="mt-1 break-all text-xs text-pf-deep/60">
            Module {receipt.moduleId} · revision {receipt.revisionId} · version {receipt.version}
          </p>
          <a
            href={`/admin/clients/${encodeURIComponent(props.tenantId)}/venues/${encodeURIComponent(props.venueId)}/content`}
            className="mt-3 inline-flex min-h-11 items-center border border-pf-primary px-4 py-2 font-semibold text-pf-primary"
          >
            Review private content
          </a>
        </div>
      ) : null}
    </section>
  )
}
