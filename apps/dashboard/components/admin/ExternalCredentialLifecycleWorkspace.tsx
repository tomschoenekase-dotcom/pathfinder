'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../lib/trpc'

const CAPABILITIES = {
  MCP: [
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
    'questions:read',
    'questions:ask',
    'delegations:create',
    'agent-runs:execute',
    'packages:draft',
    'support:draft',
    'updates:draft',
    'evaluations:request',
  ],
  PARTNER_READ_API: [
    'clients:read',
    'venues:read',
    'approved-content:read',
    'configuration:read',
    'readiness:read',
    'updates:read',
  ],
} as const

const REASONS = [
  ['ADMIN_REVOKED', 'Administrative revocation'],
  ['NO_LONGER_NEEDED', 'No longer needed'],
  ['POSSIBLE_COMPROMISE', 'Possible compromise'],
] as const

const SAFE_CAPABILITY_LABELS = new Set<string>([
  ...CAPABILITIES.MCP,
  ...CAPABILITIES.PARTNER_READ_API,
])

function capabilityLabel(value: string) {
  return SAFE_CAPABILITY_LABELS.has(value) ? value : 'Capability unavailable'
}

type Credential = {
  id: string
  venueId: string | null
  kind: 'MCP' | 'PARTNER_READ_API'
  label: string
  capabilities: string[]
  secretPrefix: string
  enabled: boolean
  expiresAt: Date | null
  revokedAt: Date | null
  updatedAt: Date
}

type ActionResult = {
  credential: Credential
  plaintextSecret: string | null
  replayed: boolean
}

type ActionScope = { tenantId: string; clientId: string; venueId: string | null }

type Props = {
  tenantId: string
  clientName: string
  venues: Array<{ id: string; name: string }>
  credential: Credential | null
  issue: (
    input: ActionScope & {
      operationId: string
      kind: Credential['kind']
      label: string
      capabilities: string[]
      expiresAt: string | null
    },
  ) => Promise<ActionResult>
  rotate: (
    input: ActionScope & {
      operationId: string
      credentialId: string
      expectedUpdatedAt: string
    },
  ) => Promise<ActionResult>
  revoke: (
    input: ActionScope & {
      operationId: string
      credentialId: string
      expectedUpdatedAt: string
      reasonCode: string
    },
  ) => Promise<ActionResult>
  activate: (
    input: Omit<ActionScope, 'venueId'> & {
      venueId: string
      operationId: string
      credentialId: string
      expectedUpdatedAt: string
    },
  ) => Promise<ActionResult>
  onRefresh?: () => void
}

type SecretView = {
  action: 'issued' | 'rotated'
  plaintext: string | null
  prefix: string
  scope: string
}

export function ExternalCredentialLifecycleWorkspace(
  props: Omit<Props, 'issue' | 'rotate' | 'revoke' | 'activate'>,
) {
  const client = useTRPCClient()
  const router = useRouter()
  return (
    <ExternalCredentialLifecycle
      {...props}
      issue={(input) => client.admin.issueExternalCredential.mutate(input)}
      rotate={(input) => client.admin.rotateExternalCredential.mutate(input)}
      revoke={(input) => client.admin.revokeExternalCredential.mutate(input)}
      activate={(input) => client.admin.activateAgentBridgeCredential.mutate(input)}
      onRefresh={() => router.refresh()}
    />
  )
}

export function ExternalCredentialLifecycle(props: Props) {
  const key = `${props.tenantId}\u0000${props.credential?.id ?? ''}\u0000${props.credential?.updatedAt.toISOString() ?? ''}`
  return <ExternalCredentialLifecycleScoped key={key} {...props} />
}

function ExternalCredentialLifecycleScoped({
  tenantId,
  clientName,
  venues,
  credential,
  issue,
  rotate,
  revoke,
  activate,
  onRefresh,
}: Props) {
  const clientId = tenantId
  const scopeIdentity = `${tenantId}\u0000${credential?.id ?? ''}\u0000${credential?.updatedAt.toISOString() ?? ''}`
  const scopeRef = useRef(scopeIdentity)
  const generationRef = useRef(0)
  const inFlightRef = useRef(false)
  const issueIdentityRef = useRef<{ key: string; operationId: string } | null>(null)
  const lifecycleIdentityRef = useRef<Record<'activate' | 'rotate' | 'revoke', string | null>>({
    activate: null,
    rotate: null,
    revoke: null,
  })
  const secretRef = useRef<SecretView | null>(null)
  const secretHeadingRef = useRef<HTMLHeadingElement>(null)
  const lifecycleHeadingRef = useRef<HTMLHeadingElement>(null)

  if (scopeRef.current !== scopeIdentity) {
    scopeRef.current = scopeIdentity
    generationRef.current += 1
    inFlightRef.current = false
    issueIdentityRef.current = null
    lifecycleIdentityRef.current = { activate: null, rotate: null, revoke: null }
    secretRef.current = null
  }

  const [label, setLabel] = useState('')
  const [venueId, setVenueId] = useState('')
  const [kind, setKind] = useState<Credential['kind']>('PARTNER_READ_API')
  const [capabilities, setCapabilities] = useState<string[]>([])
  const [expiresAt, setExpiresAt] = useState('')
  const [issueConfirmed, setIssueConfirmed] = useState(false)
  const [rotateConfirmed, setRotateConfirmed] = useState(false)
  const [revokeConfirmed, setRevokeConfirmed] = useState(false)
  const [activateConfirmed, setActivateConfirmed] = useState(false)
  const [reasonCode, setReasonCode] = useState<(typeof REASONS)[number][0]>('ADMIN_REVOKED')
  const [pending, setPending] = useState<'issue' | 'activate' | 'rotate' | 'revoke' | null>(null)
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [stale, setStale] = useState(false)
  const [, renderSecret] = useState(0)

  const scopeName = (targetVenueId: string | null) =>
    targetVenueId
      ? (venues.find((venue) => venue.id === targetVenueId)?.name ?? 'Selected venue')
      : clientName

  const begin = (action: 'issue' | 'activate' | 'rotate' | 'revoke') => {
    if (inFlightRef.current || stale) return null
    inFlightRef.current = true
    setPending(action)
    setFeedback(null)
    return { scope: scopeRef.current, generation: generationRef.current }
  }
  const current = (claim: { scope: string; generation: number }) =>
    scopeRef.current === claim.scope && generationRef.current === claim.generation
  const finish = (claim: { scope: string; generation: number }) => {
    if (current(claim)) setPending(null)
    inFlightRef.current = false
  }
  const showSecret = (view: SecretView) => {
    secretRef.current = view
    renderSecret((value) => value + 1)
    requestAnimationFrame(() => secretHeadingRef.current?.focus())
  }
  const dismissSecret = () => {
    secretRef.current = null
    renderSecret((value) => value + 1)
    onRefresh?.()
    requestAnimationFrame(() => lifecycleHeadingRef.current?.focus())
  }

  async function submitIssue() {
    if (!issueConfirmed || !label.trim() || capabilities.length === 0) return
    const claim = begin('issue')
    if (!claim) return
    const payload = {
      tenantId,
      clientId,
      venueId: venueId || null,
      kind,
      label: label.trim(),
      capabilities: [...capabilities].sort(),
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    }
    const key = JSON.stringify(payload)
    const identity =
      issueIdentityRef.current?.key === key
        ? issueIdentityRef.current
        : { key, operationId: crypto.randomUUID() }
    issueIdentityRef.current = identity
    try {
      const result = await issue({ ...payload, operationId: identity.operationId })
      if (!current(claim)) return
      setStale(true)
      showSecret({
        action: 'issued',
        plaintext: result.plaintextSecret,
        prefix: result.credential.secretPrefix,
        scope: scopeName(payload.venueId),
      })
    } catch {
      if (current(claim))
        setFeedback({
          kind: 'error',
          text: 'The result is uncertain. Keep this form unchanged and check the result.',
        })
    } finally {
      finish(claim)
    }
  }

  async function submitLifecycle(action: 'rotate' | 'revoke') {
    if (!credential || stale) return
    if (action === 'rotate' ? !rotateConfirmed : !revokeConfirmed) return
    const claim = begin(action)
    if (!claim) return
    const operationId = lifecycleIdentityRef.current[action] ?? crypto.randomUUID()
    lifecycleIdentityRef.current[action] = operationId
    const input = {
      tenantId,
      clientId,
      venueId: credential.venueId,
      credentialId: credential.id,
      expectedUpdatedAt: credential.updatedAt.toISOString(),
      operationId,
    }
    try {
      const result =
        action === 'rotate' ? await rotate(input) : await revoke({ ...input, reasonCode })
      if (!current(claim)) return
      setStale(true)
      if (action === 'rotate') {
        showSecret({
          action: 'rotated',
          plaintext: result.plaintextSecret,
          prefix: result.credential.secretPrefix,
          scope: scopeName(credential.venueId),
        })
      } else {
        setFeedback({ kind: 'success', text: 'The credential was revoked and remains disabled.' })
        onRefresh?.()
      }
    } catch {
      if (current(claim))
        setFeedback({
          kind: 'error',
          text:
            action === 'rotate'
              ? 'The rotation result is uncertain. Keep this confirmation unchanged and check the result.'
              : 'The credential could not be revoked. Refresh its current state before trying again.',
        })
    } finally {
      finish(claim)
    }
  }

  async function submitActivation() {
    if (
      !credential ||
      !credential.venueId ||
      credential.kind !== 'MCP' ||
      !credential.capabilities.includes('agent-runs:execute') ||
      credential.enabled ||
      credential.revokedAt ||
      !activateConfirmed ||
      stale
    )
      return
    const claim = begin('activate')
    if (!claim) return
    const operationId = lifecycleIdentityRef.current.activate ?? crypto.randomUUID()
    lifecycleIdentityRef.current.activate = operationId
    try {
      await activate({
        tenantId,
        clientId,
        venueId: credential.venueId,
        credentialId: credential.id,
        expectedUpdatedAt: credential.updatedAt.toISOString(),
        operationId,
      })
      if (!current(claim)) return
      setStale(true)
      setFeedback({
        kind: 'success',
        text: 'Bridge credential activated. This grants only its listed capabilities; it does not start a runner.',
      })
      onRefresh?.()
    } catch {
      if (current(claim))
        setFeedback({
          kind: 'error',
          text: 'Activation could not be confirmed. Keep this confirmation unchanged and refresh the credential state.',
        })
    } finally {
      finish(claim)
    }
  }

  const secret = secretRef.current
  const active = credential?.enabled === true
  const terminal = Boolean(credential?.revokedAt)
  const bridgeEligible = Boolean(
    credential &&
    !active &&
    !terminal &&
    credential.kind === 'MCP' &&
    credential.venueId &&
    credential.capabilities.includes('agent-runs:execute'),
  )

  return (
    <section className="space-y-5" aria-labelledby="credential-lifecycle-title">
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
        <h3
          ref={lifecycleHeadingRef}
          id="credential-lifecycle-title"
          tabIndex={-1}
          className="font-semibold text-amber-950"
        >
          External access is capability-gated
        </h3>
        <p className="mt-1 text-sm leading-6 text-amber-950">
          New credentials are disabled. Only an exact venue MCP credential carrying
          agent-runs:execute can be activated here for the staged runner bridge. Activation does not
          deploy a listener, authenticate a desktop provider, or start work.
        </p>
      </div>

      {secret ? (
        <section className="rounded-2xl border-2 border-pf-primary bg-white p-5" aria-live="off">
          <h3 ref={secretHeadingRef} tabIndex={-1} className="text-lg font-semibold text-pf-deep">
            {secret.plaintext ? 'Copy this secret now' : 'Secret is no longer available'}
          </h3>
          <p className="mt-2 text-sm leading-6 text-pf-deep/75">
            {secret.plaintext
              ? `This one-time ${secret.action} secret is for ${secret.scope}. Torchiko cannot show it again.`
              : `The ${secret.action === 'issued' ? 'issuance' : 'rotation'} completed for ${secret.scope}, but its one-time secret cannot be recovered. Review the recorded prefix ${secret.prefix} and deliberately rotate it if a replacement is required.`}
          </p>
          {secret.plaintext ? (
            <pre className="mt-3 overflow-x-auto rounded-xl bg-slate-950 p-4 text-sm text-white">
              <code>{secret.plaintext}</code>
            </pre>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            {secret.plaintext ? (
              <button
                type="button"
                className="min-h-11 rounded-full bg-pf-deep px-4 py-2 text-sm font-semibold text-white"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(secret.plaintext ?? '')
                    setFeedback({
                      kind: 'success',
                      text: 'Copied. Clipboard contents remain sensitive.',
                    })
                  } catch {
                    setFeedback({
                      kind: 'error',
                      text: 'Copy was unavailable. Select the secret text and copy it manually.',
                    })
                  }
                }}
              >
                Copy secret
              </button>
            ) : null}
            <button
              type="button"
              className="min-h-11 rounded-full border border-pf-light px-4 py-2 text-sm font-semibold text-pf-deep"
              onClick={dismissSecret}
            >
              Dismiss permanently
            </button>
          </div>
        </section>
      ) : null}

      {feedback ? (
        <p
          className={`rounded-xl p-3 text-sm ${feedback.kind === 'error' ? 'bg-rose-50 text-rose-900' : 'bg-emerald-50 text-emerald-900'}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      ) : null}

      <section className="rounded-2xl border border-pf-light bg-white p-5">
        <h3 className="text-lg font-semibold text-pf-deep">Issue disabled credential metadata</h3>
        <p className="mt-1 text-sm text-pf-deep/75">
          The secret appears only in the first confirmed response. It is never offered as a
          download.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium text-pf-deep">
            Label
            <input
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
              value={label}
              maxLength={200}
              onChange={(event) => {
                setLabel(event.currentTarget.value)
                issueIdentityRef.current = null
              }}
            />
          </label>
          <label className="text-sm font-medium text-pf-deep">
            Scope
            <select
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
              value={venueId}
              onChange={(event) => {
                setVenueId(event.currentTarget.value)
                issueIdentityRef.current = null
              }}
            >
              <option value="">Client: {clientName}</option>
              {venues.map((venue) => (
                <option key={venue.id} value={venue.id}>
                  Venue: {venue.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-pf-deep">
            Credential kind
            <select
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
              value={kind}
              onChange={(event) => {
                setKind(event.currentTarget.value as Credential['kind'])
                setCapabilities([])
                issueIdentityRef.current = null
              }}
            >
              <option value="PARTNER_READ_API">Partner Read API</option>
              <option value="MCP">MCP</option>
            </select>
          </label>
          <label className="text-sm font-medium text-pf-deep">
            Expiry (optional)
            <input
              type="datetime-local"
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
              value={expiresAt}
              onChange={(event) => {
                setExpiresAt(event.currentTarget.value)
                issueIdentityRef.current = null
              }}
            />
          </label>
        </div>
        <fieldset className="mt-4 rounded-xl border border-pf-light p-4">
          <legend className="px-1 text-sm font-semibold text-pf-deep">Capabilities</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {CAPABILITIES[kind].map((capability) => (
              <label key={capability} className="flex items-start gap-2 text-sm text-pf-deep">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={capabilities.includes(capability)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked
                    setCapabilities((currentCapabilities) =>
                      checked
                        ? [...currentCapabilities, capability]
                        : currentCapabilities.filter((value) => value !== capability),
                    )
                    issueIdentityRef.current = null
                  }}
                />
                {capability}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="mt-4 flex items-start gap-2 text-sm text-pf-deep">
          <input
            type="checkbox"
            className="mt-1"
            checked={issueConfirmed}
            onChange={(event) => setIssueConfirmed(event.currentTarget.checked)}
          />
          I confirmed the client, scope, kind, capabilities, and expiry. This record remains
          disabled.
        </label>
        <button
          type="button"
          className="mt-4 min-h-11 rounded-full bg-pf-deep px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          disabled={
            pending !== null ||
            stale ||
            !issueConfirmed ||
            !label.trim() ||
            capabilities.length === 0
          }
          onClick={() => void submitIssue()}
        >
          {feedback?.kind === 'error' && issueIdentityRef.current
            ? 'Check issue result'
            : pending === 'issue'
              ? 'Recording…'
              : 'Issue disabled credential'}
        </button>
      </section>

      {credential ? (
        <section className="rounded-2xl border border-pf-light bg-white p-5">
          <h3 className="text-lg font-semibold text-pf-deep">Selected credential lifecycle</h3>
          <p className="mt-1 text-sm text-pf-deep/75">
            {credential.label} · prefix {credential.secretPrefix}… · {scopeName(credential.venueId)}
          </p>
          <p className="mt-2 text-sm text-pf-deep/75">
            Capabilities: {credential.capabilities.map(capabilityLabel).join(', ')}
          </p>
          {terminal ? (
            <p className="mt-4 text-sm text-pf-deep/75">
              This credential is revoked. No further lifecycle action is available.
            </p>
          ) : (
            <div className="mt-5 grid gap-5 lg:grid-cols-3">
              {bridgeEligible ? (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
                  <h4 className="font-semibold text-emerald-950">Activate bridge access</h4>
                  <p className="mt-1 text-sm text-emerald-950/80">
                    Enables only this venue-scoped machine credential. The secret stays external and
                    no runner starts automatically.
                  </p>
                  <label className="mt-3 flex items-start gap-2 text-sm text-pf-deep">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={activateConfirmed}
                      onChange={(event) => setActivateConfirmed(event.currentTarget.checked)}
                    />
                    I verified the venue and the exact capability list above.
                  </label>
                  <button
                    type="button"
                    className="mt-3 min-h-11 rounded-full bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    disabled={pending !== null || stale || !activateConfirmed}
                    onClick={() => void submitActivation()}
                  >
                    {pending === 'activate' ? 'Activating…' : 'Activate bridge credential'}
                  </button>
                </div>
              ) : null}
              {active ? (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
                  <h4 className="font-semibold text-emerald-950">Bridge credential active</h4>
                  <p className="mt-1 text-sm text-emerald-950/80">
                    A compatible authenticated transport may use the listed capabilities. Rotate or
                    revoke below to disable this credential permanently.
                  </p>
                </div>
              ) : null}
              <div className="rounded-xl border border-pf-light p-4">
                <h4 className="font-semibold text-pf-deep">Rotate</h4>
                <p className="mt-1 text-sm text-pf-deep/75">
                  Rotation revokes this record and creates a disabled replacement with the same
                  scope and capabilities. Its secret is shown once.
                </p>
                <label className="mt-3 flex items-start gap-2 text-sm text-pf-deep">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={rotateConfirmed}
                    onChange={(event) => setRotateConfirmed(event.currentTarget.checked)}
                  />
                  I confirmed the prefix and scope shown above.
                </label>
                <button
                  type="button"
                  className="mt-3 min-h-11 rounded-full border border-pf-primary px-4 py-2 text-sm font-semibold text-pf-primary disabled:opacity-50"
                  disabled={pending !== null || stale || !rotateConfirmed}
                  onClick={() => void submitLifecycle('rotate')}
                >
                  {feedback?.kind === 'error' && lifecycleIdentityRef.current.rotate
                    ? 'Check rotation result'
                    : pending === 'rotate'
                      ? 'Rotating…'
                      : 'Rotate credential'}
                </button>
              </div>
              <div className="rounded-xl border border-rose-200 p-4">
                <h4 className="font-semibold text-rose-950">Revoke</h4>
                <label className="mt-3 block text-sm font-medium text-pf-deep">
                  Reason
                  <select
                    className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
                    value={reasonCode}
                    onChange={(event) => {
                      setReasonCode(event.currentTarget.value as typeof reasonCode)
                      lifecycleIdentityRef.current.revoke = null
                    }}
                  >
                    {REASONS.map(([code, label]) => (
                      <option key={code} value={code}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="mt-3 flex items-start gap-2 text-sm text-pf-deep">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={revokeConfirmed}
                    onChange={(event) => setRevokeConfirmed(event.currentTarget.checked)}
                  />
                  I understand revocation is permanent.
                </label>
                <button
                  type="button"
                  className="mt-3 min-h-11 rounded-full bg-rose-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  disabled={pending !== null || stale || !revokeConfirmed}
                  onClick={() => void submitLifecycle('revoke')}
                >
                  {pending === 'revoke' ? 'Revoking…' : 'Revoke permanently'}
                </button>
              </div>
            </div>
          )}
        </section>
      ) : null}
    </section>
  )
}
