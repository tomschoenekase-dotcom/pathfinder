'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'

import {
  AGENT_DIRECT_EXECUTION_ROUTE,
  AgentAccessCapability,
  AgentAutonomousAction,
  AgentConfigurationAutonomyLevel,
  AgentExecutionProvider,
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
  defaultProvider: (typeof AgentExecutionProvider.options)[number] | null
  defaultModel: string | null
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

function apiFields(fields: Fields) {
  const { defaultProvider, defaultModel, ...authority } = fields
  return {
    ...authority,
    ...(defaultProvider && defaultModel ? { defaultProvider, defaultModel } : {}),
  }
}

function FieldsEditor({
  fields,
  setFields,
  configurationHref,
}: {
  fields: Fields
  setFields: (next: Fields) => void
  configurationHref: string
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
      <label className="text-sm font-medium text-pf-deep">
        Execution route
        <select
          className="mt-1 w-full rounded-xl border border-pf-light bg-white px-3 py-2"
          value={fields.defaultProvider ?? ''}
          onChange={(event) =>
            setFields({
              ...fields,
              defaultProvider: (event.target.value || null) as Fields['defaultProvider'],
              defaultModel:
                event.target.value === 'anthropic'
                  ? AGENT_DIRECT_EXECUTION_ROUTE
                  : event.target.value
                    ? fields.defaultProvider === 'anthropic'
                      ? 'subscription-default'
                      : fields.defaultModel
                    : null,
            })
          }
        >
          <option value="">Not configured</option>
          {AgentExecutionProvider.options.map((provider) => (
            <option key={provider} value={provider}>
              {provider === 'anthropic' ? 'Torchiko managed AI' : provider}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm font-medium text-pf-deep">
        {fields.defaultProvider === 'anthropic' ? 'Managed workload' : 'Bridge model target'}
        <input
          className="mt-1 w-full rounded-xl border border-pf-light bg-white px-3 py-2"
          value={fields.defaultModel ?? ''}
          disabled={!fields.defaultProvider || fields.defaultProvider === 'anthropic'}
          placeholder={
            fields.defaultProvider === 'anthropic'
              ? AGENT_DIRECT_EXECUTION_ROUTE
              : 'subscription-default'
          }
          onChange={(event) => setFields({ ...fields, defaultModel: event.target.value || null })}
        />
        {fields.defaultProvider === 'anthropic' ? (
          <span className="mt-1 block text-xs font-normal leading-5 text-pf-deep/60">
            Exact model, fallback, timeout, retries, output, and request budget are governed in{' '}
            <a className="font-semibold text-pf-primary underline" href={configurationHref}>
              AI workload configuration
            </a>
            . Saving or enabling this identity does not call a provider.
          </span>
        ) : null}
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
  defaultProvider: null,
  defaultModel: null,
}

const identityTemplates: Array<{ label: string; fields: Fields }> = [
  {
    label: 'Primary coordinator',
    fields: {
      identityKey: 'edith.primary',
      name: 'EDITH',
      description:
        'Primary operator interface. Clarifies goals, chooses the narrowest capable specialist, delegates with explicit scope, and reports durable evidence without pretending work occurred.',
      agentType: 'PRIMARY',
      accessCapabilities: ['agents.read', 'agents.delegate', 'operations.read'],
      autonomyLevel: 'INTERNAL_REVERSIBLE',
      autonomousActions: ['agents.delegate-specialist'],
      defaultProvider: null,
      defaultModel: null,
    },
  },
  {
    label: 'Content steward',
    fields: {
      identityKey: 'content.steward',
      name: 'Content Steward',
      description:
        'Grounds recommendations in approved venue content, prepares reviewable drafts, preserves provenance, and never publishes or invents missing facts.',
      agentType: 'CONTENT',
      accessCapabilities: ['content.read', 'content.draft'],
      autonomyLevel: 'DRAFT',
      autonomousActions: ['content.prepare-draft'],
      defaultProvider: null,
      defaultModel: null,
    },
  },
  {
    label: 'Reliability evaluator',
    fields: {
      identityKey: 'reliability.evaluator',
      name: 'Reliability Evaluator',
      description:
        'Inspects evaluation, operations, and readiness evidence; distinguishes observed facts from proposed thresholds and escalates unsafe uncertainty.',
      agentType: 'EVALUATION',
      accessCapabilities: ['evaluation.read', 'operations.read'],
      autonomyLevel: 'READ_ONLY',
      autonomousActions: [],
      defaultProvider: null,
      defaultModel: null,
    },
  },
  {
    label: 'Support specialist',
    fields: {
      identityKey: 'support.specialist',
      name: 'Support Specialist',
      description:
        'Reviews bounded support context, prepares empathetic internal guidance, asks when facts are missing, and never sends an external message.',
      agentType: 'SUPPORT',
      accessCapabilities: ['support.read', 'content.read'],
      autonomyLevel: 'READ_ONLY',
      autonomousActions: [],
      defaultProvider: null,
      defaultModel: null,
    },
  },
  {
    label: 'Torchiko architect',
    fields: {
      identityKey: 'pathfinder.architect',
      name: 'Torchiko Architect',
      description:
        'Maps product architecture, boundaries, dependencies, and implementation gaps to repository evidence; it labels unknown state and delegates code changes to a capable worker.',
      agentType: 'OPERATIONS',
      accessCapabilities: ['operations.read', 'evaluation.read', 'content.read', 'agents.read'],
      autonomyLevel: 'READ_ONLY',
      autonomousActions: [],
      defaultProvider: null,
      defaultModel: null,
    },
  },
  {
    label: 'Data steward',
    fields: {
      identityKey: 'pathfinder.data-steward',
      name: 'Torchiko Data Steward',
      description:
        'Audits content, intake, evaluation, and operational records with exact source and count evidence; never invents tolerances, causes, reconciliation, or acceptance policy.',
      agentType: 'OPERATIONS',
      accessCapabilities: ['content.read', 'intake.read', 'evaluation.read', 'operations.read'],
      autonomyLevel: 'READ_ONLY',
      autonomousActions: [],
      defaultProvider: null,
      defaultModel: null,
    },
  },
  {
    label: 'Experience designer',
    fields: {
      identityKey: 'pathfinder.experience',
      name: 'Torchiko Experience Designer',
      description:
        'Designs calm operator and guest workflows from observed product constraints, prepares reviewable UX copy, and labels accessibility or responsive behavior as proposed until tested.',
      agentType: 'CONTENT',
      accessCapabilities: ['content.read', 'content.draft'],
      autonomyLevel: 'DRAFT',
      autonomousActions: ['content.prepare-draft'],
      defaultProvider: null,
      defaultModel: null,
    },
  },
  {
    label: 'Outreach steward',
    fields: {
      identityKey: 'pathfinder.outreach',
      name: 'Torchiko Outreach Steward',
      description:
        'Reviews outreach and venue context, prepares grounded internal recommendations, and never contacts a person or claims delivery without an explicit approved communication surface.',
      agentType: 'SUPPORT',
      accessCapabilities: ['support.read', 'content.read', 'operations.read'],
      autonomyLevel: 'READ_ONLY',
      autonomousActions: [],
      defaultProvider: null,
      defaultModel: null,
    },
  },
  {
    label: 'Media curator',
    fields: {
      identityKey: 'media.curator',
      name: 'Media Curator',
      description:
        'Inspects approved media and content context, identifies quality or coverage gaps, and proposes bounded work without uploading, deleting, publishing, or fabricating assets.',
      agentType: 'MEDIA',
      accessCapabilities: ['media.read', 'content.read'],
      autonomyLevel: 'READ_ONLY',
      autonomousActions: [],
      defaultProvider: null,
      defaultModel: null,
    },
  },
]

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
        fields: apiFields(fields),
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
        <fieldset className="rounded-xl border border-sky-200 bg-white p-3">
          <legend className="px-1 text-sm font-semibold text-sky-950">Start from a role</legend>
          <p className="mb-3 text-xs leading-5 text-pf-deep/55">
            Templates define a narrow personality and authority boundary. Review every field before
            creating; the identity remains disabled.
          </p>
          <div className="flex flex-wrap gap-2">
            {identityTemplates.map((template) => (
              <button
                key={template.label}
                type="button"
                disabled={busy}
                onClick={() => {
                  setFields(template.fields)
                  setMessage(null)
                }}
                className="rounded-full border border-sky-200 px-3 py-2 text-xs font-semibold text-sky-950"
              >
                {template.label}
              </button>
            ))}
          </div>
        </fieldset>
        <FieldsEditor
          fields={fields}
          setFields={setFields}
          configurationHref={`/admin/clients/${tenantId}/venues/${venueId}/ai-configuration`}
        />
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

  async function mutate(kind: 'edit' | 'disable' | 'enable') {
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
        await client.admin.editDisabledAgentIdentity.mutate({
          ...common,
          fields: apiFields(fields),
        })
        setMessage('Disabled configuration saved. No agent was enabled or run.')
      } else if (kind === 'disable') {
        await client.admin.disableAgentIdentity.mutate(common)
        setMessage('Identity disabled. No run was started.')
      } else {
        await client.admin.enableAgentIdentity.mutate(common)
        setMessage('Identity enabled. This does not start a run.')
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
          <FieldsEditor
            fields={fields}
            setFields={setFields}
            configurationHref={`/admin/clients/${tenantId}/venues/${venueId}/ai-configuration`}
          />
        )}
        <div className="flex flex-wrap gap-3">
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
          {!identity.enabled ? (
            <button
              type="button"
              disabled={busy || !identity.defaultProvider || !identity.defaultModel}
              onClick={() => void mutate('enable')}
              className="min-h-11 rounded-xl border border-pf-primary bg-white px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
            >
              Enable configured identity
            </button>
          ) : null}
        </div>
        {message ? (
          <p role="status" className="text-sm text-pf-deep/70">
            {message}
          </p>
        ) : null}
      </div>
    </details>
  )
}
