'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'

import {
  AgentAccessCapability,
  AgentAutonomousAction,
  AgentConfigurationAutonomyLevel,
  AgentIdentityType,
  agentConfigurationCoherenceIssue,
} from '@pathfinder/contracts'

import { useTRPCClient } from '../../lib/trpc'

type Fields = {
  identityKey: string
  name: string
  description: string | null
  agentType: (typeof AgentIdentityType.options)[number]
  accessCapabilities: (typeof AgentAccessCapability.options)[number][]
  autonomyLevel: (typeof AgentConfigurationAutonomyLevel.options)[number]
  autonomousActions: (typeof AgentAutonomousAction.options)[number][]
}

type ExistingIdentity = Fields & {
  id: string
  enabled: boolean
  updatedAt: Date
}

function errorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  return data && typeof data === 'object' && 'code' in data ? data.code : null
}

function toggle<T extends string>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
}

function FieldsEditor({
  fields,
  setFields,
}: {
  fields: Fields
  setFields: (next: Fields) => void
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm font-medium text-pf-deep">
        Identity key
        <input
          className="mt-1 w-full rounded-xl border border-pf-light bg-white px-3 py-2"
          value={fields.identityKey}
          pattern="[a-z0-9]+([.-][a-z0-9]+)*"
          required
          onChange={(event) => setFields({ ...fields, identityKey: event.target.value })}
        />
      </label>
      <label className="text-sm font-medium text-pf-deep">
        Display name
        <input
          className="mt-1 w-full rounded-xl border border-pf-light bg-white px-3 py-2"
          value={fields.name}
          required
          onChange={(event) => setFields({ ...fields, name: event.target.value })}
        />
      </label>
      <label className="text-sm font-medium text-pf-deep">
        Identity type
        <select
          className="mt-1 w-full rounded-xl border border-pf-light bg-white px-3 py-2"
          value={fields.agentType}
          onChange={(event) =>
            setFields({ ...fields, agentType: event.target.value as Fields['agentType'] })
          }
        >
          {AgentIdentityType.options.map((option) => (
            <option key={option} value={option}>
              {option.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm font-medium text-pf-deep">
        Autonomy ceiling
        <select
          className="mt-1 w-full rounded-xl border border-pf-light bg-white px-3 py-2"
          value={fields.autonomyLevel}
          onChange={(event) =>
            setFields({
              ...fields,
              autonomyLevel: event.target.value as Fields['autonomyLevel'],
              ...(event.target.value === 'READ_ONLY' ? { autonomousActions: [] } : {}),
            })
          }
        >
          {AgentConfigurationAutonomyLevel.options.map((option) => (
            <option key={option} value={option}>
              {option.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm font-medium text-pf-deep sm:col-span-2">
        Description
        <textarea
          className="mt-1 min-h-20 w-full rounded-xl border border-pf-light bg-white px-3 py-2"
          value={fields.description ?? ''}
          onChange={(event) => setFields({ ...fields, description: event.target.value || null })}
        />
      </label>
      <fieldset className="rounded-xl border border-pf-light p-3">
        <legend className="px-1 text-sm font-semibold text-pf-deep">Access capabilities</legend>
        <div className="mt-2 grid gap-2">
          {AgentAccessCapability.options.map((capability) => (
            <label key={capability} className="flex items-center gap-2 text-sm text-pf-deep/75">
              <input
                type="checkbox"
                checked={fields.accessCapabilities.includes(capability)}
                onChange={() =>
                  setFields({
                    ...fields,
                    accessCapabilities: toggle(fields.accessCapabilities, capability),
                  })
                }
              />
              {capability}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="rounded-xl border border-pf-light p-3">
        <legend className="px-1 text-sm font-semibold text-pf-deep">Autonomous actions</legend>
        <p className="mb-2 text-xs text-pf-deep/55">A disabled identity cannot execute these.</p>
        <div className="grid gap-2">
          {AgentAutonomousAction.options.map((action) => (
            <label key={action} className="flex items-center gap-2 text-sm text-pf-deep/75">
              <input
                type="checkbox"
                checked={fields.autonomousActions.includes(action)}
                disabled={fields.autonomyLevel === 'READ_ONLY'}
                onChange={() =>
                  setFields({
                    ...fields,
                    autonomousActions: toggle(fields.autonomousActions, action),
                  })
                }
              />
              {action}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  )
}

const emptyFields: Fields = {
  identityKey: '',
  name: '',
  description: null,
  agentType: 'CONTENT',
  accessCapabilities: ['content.read'],
  autonomyLevel: 'READ_ONLY',
  autonomousActions: [],
}

export function AgentIdentityCreateEditor({
  tenantId,
  venueId,
}: {
  tenantId: string
  venueId: string
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [fields, setFields] = useState<Fields>(emptyFields)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const issue = agentConfigurationCoherenceIssue(fields)
    if (issue) return setMessage(issue)
    setBusy(true)
    setMessage(null)
    try {
      await client.admin.createDisabledAgentIdentity.mutate({
        scope: { level: 'VENUE', tenantId, venueId },
        fields,
      })
      setFields(emptyFields)
      setMessage('Disabled identity created. No agent was enabled or run.')
      router.refresh()
    } catch (error) {
      setMessage(
        errorCode(error) === 'CONFLICT'
          ? 'That identity key already exists for this client. Refresh to inspect the existing disabled identity before trying another key.'
          : 'The identity was not created. No agent was enabled or run.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="rounded-2xl border border-sky-200 bg-sky-50/60 p-4">
      <summary className="cursor-pointer font-semibold text-sky-950">
        Create disabled identity
      </summary>
      <form className="mt-4 space-y-4" onSubmit={submit}>
        <FieldsEditor fields={fields} setFields={setFields} />
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 rounded-xl bg-pf-primary px-4 text-sm font-semibold text-white disabled:opacity-60"
        >
          {busy ? 'Creating disabled identity...' : 'Create disabled identity'}
        </button>
        {message ? (
          <p role="status" className="text-sm text-pf-deep/70">
            {message}
          </p>
        ) : null}
      </form>
    </details>
  )
}

export function AgentIdentityEditEditor({
  tenantId,
  venueId,
  identity,
}: {
  tenantId: string
  venueId: string
  identity: ExistingIdentity
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [fields, setFields] = useState<Fields>(identity)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function mutate(kind: 'edit' | 'disable') {
    const issue = kind === 'edit' ? agentConfigurationCoherenceIssue(fields) : null
    if (issue) return setMessage(issue)
    setBusy(true)
    setMessage(null)
    try {
      const common = {
        scope: { level: 'VENUE' as const, tenantId, venueId },
        agentIdentityId: identity.id,
        expectedUpdatedAt: identity.updatedAt,
      }
      if (kind === 'edit') {
        await client.admin.editDisabledAgentIdentity.mutate({ ...common, fields })
        setMessage('Disabled configuration saved. No agent was enabled or run.')
      } else {
        await client.admin.disableAgentIdentity.mutate(common)
        setMessage('Identity disabled. No run was started.')
      }
      router.refresh()
    } catch (error) {
      setMessage(
        errorCode(error) === 'CONFLICT'
          ? 'Configuration changed or is no longer eligible. Refresh before retrying.'
          : 'The configuration change could not be confirmed. No run was started.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="mt-4 rounded-xl border border-pf-light bg-pf-surface/40 p-3">
      <summary className="cursor-pointer text-sm font-semibold text-pf-primary">
        {identity.enabled ? 'Disable identity' : 'Edit disabled configuration'}
      </summary>
      <div className="mt-4 space-y-4">
        {identity.enabled ? (
          <p className="text-sm text-pf-deep/70">
            Enabled identities are locked against configuration edits. This workspace can only
            disable them.
          </p>
        ) : (
          <FieldsEditor fields={fields} setFields={setFields} />
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void mutate(identity.enabled ? 'disable' : 'edit')}
          className="min-h-11 rounded-xl bg-pf-primary px-4 text-sm font-semibold text-white disabled:opacity-60"
        >
          {busy
            ? 'Saving...'
            : identity.enabled
              ? 'Disable identity'
              : 'Save disabled configuration'}
        </button>
        {message ? (
          <p role="status" className="text-sm text-pf-deep/70">
            {message}
          </p>
        ) : null}
      </div>
    </details>
  )
}
