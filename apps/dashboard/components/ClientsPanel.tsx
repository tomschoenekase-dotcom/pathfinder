'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { trpc as api } from '../lib/trpc'

type User = { id: string; email: string; fullName: string | null }
type Membership = { id: string; role: string; user: User }
type Client = {
  id: string
  name: string
  slug: string
  status: string
  createdAt: Date
  memberships: Membership[]
}

type ClientsPanelProps = {
  clients: Client[]
}

export function ClientsPanel({ clients: initial }: ClientsPanelProps) {
  const router = useRouter()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ orgId: '', name: '', slug: '', userId: '', userEmail: '' })
  const [error, setError] = useState('')

  const createClient = api.admin.createClient.useMutation({
    onSuccess: () => {
      setShowForm(false)
      setForm({ orgId: '', name: '', slug: '', userId: '', userEmail: '' })
      setError('')
      router.refresh()
    },
    onError: (e) => setError(e.message),
  })

  const updateStatus = api.admin.updateClientStatus.useMutation({
    onSuccess: () => router.refresh(),
  })

  return (
    <div className="p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Clients</h1>
          <p className="mt-1 text-sm text-slate-500">{initial.length} total</p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-600"
        >
          + Add Client
        </button>
      </div>

      {showForm && (
        <div className="mb-8 rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">New Client</h2>
          <div className="grid grid-cols-2 gap-4">
            {[
              { key: 'orgId', label: 'Clerk Org ID', placeholder: 'org_...' },
              { key: 'name', label: 'Company Name', placeholder: 'Acme Corp' },
              { key: 'slug', label: 'Slug', placeholder: 'acme-corp' },
              { key: 'userId', label: 'Owner Clerk User ID', placeholder: 'user_...' },
              { key: 'userEmail', label: 'Owner Email', placeholder: 'owner@acme.com' },
            ].map(({ key, label, placeholder }) => (
              <div key={key}>
                <label className="mb-1 block text-xs font-medium text-slate-600">{label}</label>
                <input
                  type="text"
                  placeholder={placeholder}
                  value={form[key as keyof typeof form]}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-400"
                />
              </div>
            ))}
          </div>
          {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={() => createClient.mutate(form)}
              disabled={createClient.isPending}
              className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-50"
            >
              {createClient.isPending ? 'Creating...' : 'Create'}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {initial.map((client) => (
          <div key={client.id} className="rounded-2xl border border-slate-200 bg-white p-6">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-semibold text-slate-900">{client.name}</h2>
                  <span className={[
                    'rounded-full px-2 py-0.5 text-xs font-medium',
                    client.status === 'ACTIVE' ? 'bg-green-100 text-green-700' :
                    client.status === 'SUSPENDED' ? 'bg-yellow-100 text-yellow-700' :
                    'bg-blue-100 text-blue-700',
                  ].join(' ')}>
                    {client.status}
                  </span>
                </div>
                <p className="mt-1 font-mono text-xs text-slate-400">{client.id}</p>
                <p className="text-xs text-slate-400">slug: {client.slug}</p>
                <p className="mt-1 text-xs text-slate-400">
                  Created {new Date(client.createdAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex gap-2">
                {client.status !== 'ACTIVE' && (
                  <button
                    type="button"
                    onClick={() => updateStatus.mutate({ tenantId: client.id, status: 'ACTIVE' })}
                    className="rounded-lg border border-green-200 px-3 py-1.5 text-xs font-medium text-green-700 hover:bg-green-50"
                  >
                    Activate
                  </button>
                )}
                {client.status === 'ACTIVE' && (
                  <button
                    type="button"
                    onClick={() => updateStatus.mutate({ tenantId: client.id, status: 'SUSPENDED' })}
                    className="rounded-lg border border-yellow-200 px-3 py-1.5 text-xs font-medium text-yellow-700 hover:bg-yellow-50"
                  >
                    Suspend
                  </button>
                )}
              </div>
            </div>

            {client.memberships.length > 0 && (
              <div className="mt-4 border-t border-slate-100 pt-4">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Members</p>
                <div className="space-y-1">
                  {client.memberships.map((m) => (
                    <div key={m.id} className="flex items-center gap-3 text-sm">
                      <span className="font-medium text-slate-700">{m.user.email}</span>
                      {m.user.fullName && <span className="text-slate-400">{m.user.fullName}</span>}
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{m.role}</span>
                      <span className="font-mono text-xs text-slate-300">{m.user.id}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
