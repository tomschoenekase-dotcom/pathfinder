'use client'

import { AdminChatlogNotableToggle } from '../../../components/admin/AdminChatlogNotableToggle'
import { AdminChatlogNoteForm } from '../../../components/admin/AdminChatlogNoteForm'
import { AdminClientPlanForm } from '../../../components/admin/AdminClientPlanForm'
import { AdminClientStatusForm } from '../../../components/admin/AdminClientStatusForm'
import { AdminCreateClientForm } from '../../../components/admin/AdminCreateClientForm'
import { TRPCProvider } from '../../../lib/trpc'

const revision = '2026-08-27T23:30:00.000Z'

export function AdminAccessibilityFixture() {
  return (
    <TRPCProvider scopeKey="admin-accessibility-fixture">
      <main className="min-h-screen bg-pf-surface px-4 py-8 text-pf-deep sm:px-8">
        <div className="mx-auto max-w-4xl space-y-8">
          <header className="space-y-2">
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-pf-primary">
              Provider-dark accessibility fixture
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">Admin control semantics</h1>
            <p className="max-w-2xl text-sm leading-6 text-pf-deep/70">
              Exact production controls rendered without customer data or network actions.
            </p>
          </header>

          <section
            aria-labelledby="account-controls-heading"
            className="space-y-5 rounded-3xl bg-white p-6"
          >
            <h2 id="account-controls-heading" className="text-xl font-semibold">
              Account controls
            </h2>
            <AdminClientStatusForm
              tenantId="synthetic-tenant"
              currentStatus="ACTIVE"
              expectedUpdatedAt={revision}
            />
            <AdminClientPlanForm
              tenantId="synthetic-tenant"
              currentPlanTier="free"
              expectedUpdatedAt={revision}
            />
          </section>

          <section
            aria-labelledby="conversation-controls-heading"
            className="space-y-5 rounded-3xl bg-white p-6"
          >
            <h2 id="conversation-controls-heading" className="text-xl font-semibold">
              Conversation review
            </h2>
            <AdminChatlogNotableToggle
              tenantId="synthetic-tenant"
              venueId="synthetic-venue"
              sessionId="synthetic-session"
              initialIsNotable={false}
            />
            <AdminChatlogNoteForm
              tenantId="synthetic-tenant"
              venueId="synthetic-venue"
              sessionId="synthetic-session"
              initialNotes={[]}
            />
          </section>

          <section aria-labelledby="workspace-controls-heading" className="space-y-5">
            <h2 id="workspace-controls-heading" className="text-xl font-semibold">
              Workspace creation
            </h2>
            <AdminCreateClientForm />
          </section>
        </div>
      </main>
    </TRPCProvider>
  )
}
