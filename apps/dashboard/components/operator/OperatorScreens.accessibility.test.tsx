/* @vitest-environment jsdom */
import React from 'react'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  post: vi.fn(),
  searchParams: new URLSearchParams(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/operator',
  useRouter: () => ({ refresh: mocks.refresh, replace: vi.fn() }),
  useSearchParams: () => mocks.searchParams,
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
// Reverification is Clerk's job; here the wrapped call simply runs.
vi.mock('@clerk/nextjs', () => ({
  useReverification: (fetcher: (body: unknown) => Promise<unknown>) => fetcher,
}))
vi.mock('../admin/AdminCommandPalette', () => ({
  AdminCommandPalette: () => (
    <button
      type="button"
      className="min-h-11 w-full rounded-lg bg-slate-900 px-3 text-left text-sm text-slate-300"
    >
      Search Torchiko OS
    </button>
  ),
}))
vi.mock('@pathfinder/ui', () => ({ TorchikoBrand: () => <span>Torchiko</span> }))

import { ApprovePanel as ApproveInvoker } from '../../app/approve/[id]/ApprovePanel'
import { AdminSectionShell } from '../admin/AdminSectionShell'
import { OperatorAdminView, type OperatorTabId } from './OperatorAdminView'
import { OperatorApproveView } from './OperatorApproveView'
import { OperatorAudit } from './OperatorAudit'
import { OperatorAutonomy } from './OperatorAutonomy'
import { OperatorConnections } from './OperatorConnections'
import { OperatorInbox } from './OperatorInbox'
import { OperatorJobGrants } from './OperatorJobGrants'
import type {
  OperatorAuditRowView,
  OperatorAutonomyRow,
  OperatorConnectionRow,
  OperatorJobGrantPanel,
  OperatorReviewItemView,
} from './types'

const now = new Date('2026-09-30T15:00:00Z')
const hash = 'b'.repeat(64)

// All names below are invented.
const appearance: OperatorReviewItemView = {
  id: 'prop_1',
  type: 'proposal',
  title: 'Update visitor chat appearance',
  status: 'PENDING',
  argsHash: hash,
  clientName: 'Example Assistant',
  createdAt: new Date('2026-09-30T14:20:00Z'),
  expiresAt: new Date('2026-10-03T14:20:00Z'),
  steps: [
    {
      index: 0,
      proposalId: 'prop_1',
      tool: 'appearance.propose_update',
      status: 'PENDING',
      title: 'Update visitor chat appearance',
      lines: ['chatTheme → "midnight"', 'chatAccentColor → "#0F6B8A"'],
      tenantName: 'Harbor Museum',
      venueName: 'Main Hall',
      changeMode: null,
      changes: [],
      args: JSON.stringify({ chatTheme: 'midnight', chatAccentColor: '#0F6B8A' }, null, 2),
      failureCode: null,
    },
  ],
}

const plan: OperatorReviewItemView = {
  id: 'plan_1',
  type: 'plan',
  title: 'Set up Lakeside Aquarium and invite the owner',
  status: 'PENDING',
  argsHash: hash,
  clientName: 'Example Assistant',
  createdAt: new Date('2026-09-30T13:05:00Z'),
  expiresAt: new Date('2026-10-03T13:05:00Z'),
  steps: [
    ['Create venue', 'venues.propose_create', 'name → "Lakeside Aquarium"'],
    ['Add a public source', 'venues.propose_source', 'url → https://aquarium.example.com/visit'],
    ['Apply the harbor theme', 'appearance.propose_update', 'chatTheme → "harbor"'],
    ['Publish the visitor chat', 'venues.propose_publish', 'publish → true'],
    ['Invite the owner', 'customers.propose_invite', 'email → o***@aquarium.example.com'],
  ].map(([title, tool, line], index) => ({
    index,
    proposalId: `step_${index}`,
    tool: tool!,
    status: 'PENDING',
    title: title!,
    lines: [line!],
    tenantName: 'Lakeside Aquarium Group',
    venueName: index === 0 ? null : 'Lakeside Aquarium',
    changeMode: null,
    changes: [],
    args: '{}',
    failureCode: null,
  })),
}

const revert: OperatorReviewItemView = {
  ...appearance,
  id: 'rev_1',
  title: 'Undo: Update visitor chat appearance',
  steps: [
    {
      ...appearance.steps[0]!,
      proposalId: 'rev_1',
      title: 'Undo: Update visitor chat appearance',
      lines: ['Restores the values from before the original change was applied.'],
      changeMode: 'restore',
      changes: [
        { field: 'chatTheme', before: 'midnight', after: 'paper' },
        { field: 'chatAccentColor', before: '#0F6B8A', after: '#B4532A' },
      ],
    },
  ],
}

const autonomyRows: OperatorAutonomyRow[] = [
  { capability: 'crm:propose', mode: 'ask', locked: false, autoKinds: [] },
  { capability: 'crm:log', mode: 'auto', locked: false, autoKinds: [] },
  { capability: 'venues:propose', mode: 'ask', locked: false, autoKinds: [] },
  { capability: 'appearance:propose', mode: 'auto', locked: false, autoKinds: [] },
  { capability: 'customers:propose', mode: 'ask', locked: true, autoKinds: [] },
  { capability: 'support:propose', mode: 'ask', locked: false, autoKinds: [] },
  { capability: 'operator:plan', mode: 'ask', locked: true, autoKinds: [] },
  { capability: 'operator:revert', mode: 'ask', locked: true, autoKinds: [] },
]

const connections: OperatorConnectionRow[] = [
  {
    grantId: 'grant_1',
    clientName: 'Example Assistant',
    redirectHosts: ['connector.example.com'],
    lastUsedAt: new Date('2026-09-30T14:40:00Z'),
    createdAt: new Date('2026-09-15T10:00:00Z'),
    expiresAt: new Date('2026-12-14T10:00:00Z'),
    revokedAt: null,
    revokeReason: null,
    status: 'active',
    scope: 'All clients, 13 capabilities',
  },
  {
    grantId: 'grant_0',
    clientName: 'Old Test Connector',
    redirectHosts: ['127.0.0.1:8123'],
    lastUsedAt: null,
    createdAt: new Date('2026-08-01T10:00:00Z'),
    expiresAt: new Date('2026-10-30T10:00:00Z'),
    revokedAt: new Date('2026-08-02T10:00:00Z'),
    revokeReason: 'dashboard_revoke',
    status: 'revoked',
    scope: '1 client(s), 3 capabilities',
  },
]

const auditRows: OperatorAuditRowView[] = [
  {
    id: 'a1',
    occurredAt: new Date('2026-09-30T14:41:00Z'),
    eventType: 'mcp.call',
    outcome: 'OK',
    tool: 'crm.search_organizations',
    clientName: 'Example Assistant',
    tenantName: null,
    venueName: null,
    proposalId: null,
    planId: null,
    latencyMs: 42,
    redactedArgs: JSON.stringify({ query: 'science museum', limit: 5 }, null, 2),
  },
  {
    id: 'a2',
    occurredAt: new Date('2026-09-30T14:20:00Z'),
    eventType: 'proposal.transition',
    outcome: 'CREATED',
    tool: 'appearance.propose_update',
    clientName: 'Example Assistant',
    tenantName: 'Harbor Museum',
    venueName: 'Main Hall',
    proposalId: 'prop_1',
    planId: null,
    latencyMs: null,
    redactedArgs: JSON.stringify({ chatTheme: 'midnight', note: '[text:120]' }, null, 2),
  },
  {
    id: 'a3',
    occurredAt: new Date('2026-09-30T09:02:00Z'),
    eventType: 'autonomy.change',
    outcome: 'AUTO',
    tool: null,
    clientName: null,
    tenantName: null,
    venueName: null,
    proposalId: null,
    planId: null,
    latencyMs: null,
    redactedArgs: JSON.stringify({ capability: 'crm:log' }, null, 2),
  },
]

const jobGrantPanel: OperatorJobGrantPanel = {
  grants: [
    {
      id: 'jg_active',
      name: 'Weekly look refresh',
      clientId: 'opc_1',
      clientName: 'Example Assistant',
      tenantId: 'tenant_a',
      tenantName: 'Harbor Museum',
      venueId: null,
      kinds: ['appearance.update'],
      maxExecutions: 5,
      remainingExecutions: 3,
      maxAmountCents: null,
      remainingAmountCents: null,
      expiresAt: new Date('2026-10-01T15:00:00Z'),
      revokedAt: null,
      createdAt: new Date('2026-09-30T14:00:00Z'),
      status: 'active',
    },
    {
      id: 'jg_used',
      name: 'Old job',
      clientId: 'opc_1',
      clientName: 'Example Assistant',
      tenantId: 'tenant_a',
      tenantName: 'Harbor Museum',
      venueId: 'venue_1',
      kinds: ['appearance.update'],
      maxExecutions: 1,
      remainingExecutions: 0,
      maxAmountCents: null,
      remainingAmountCents: null,
      expiresAt: new Date('2026-10-01T15:00:00Z'),
      revokedAt: null,
      createdAt: new Date('2026-09-29T14:00:00Z'),
      status: 'exhausted',
    },
  ],
  clients: [{ id: 'opc_1', name: 'Example Assistant' }],
  tenants: [{ id: 'tenant_a', name: 'Harbor Museum' }],
  kinds: [
    {
      kind: 'appearance.update',
      tool: 'appearance.propose_update',
      capability: 'appearance:propose',
      carriesAmount: false,
    },
  ],
}

const noFilters = { eventType: '', outcome: '', tool: '', days: '' }

function shell(tab: OperatorTabId | null, inboxCount: number | null, content: React.ReactNode) {
  return (
    <AdminSectionShell routePathname="/admin/operator" showOperator>
      <OperatorAdminView tab={tab} inboxCount={inboxCount}>
        {content}
      </OperatorAdminView>
    </AdminSectionShell>
  )
}

const approvePanel = (item: OperatorReviewItemView) => (
  <ApproveInvoker id={item.id} argsHash={item.argsHash} label={item.title} />
)

const screens: Record<string, React.ReactElement> = {
  'admin-inbox': shell('inbox', 2, <OperatorInbox items={[plan, appearance]} now={now} />),
  'admin-inbox-empty': shell('inbox', 0, <OperatorInbox items={[]} now={now} />),
  'admin-autonomy': shell('autonomy', null, <OperatorAutonomy rows={autonomyRows} />),
  'admin-connections': shell(
    'connections',
    null,
    <OperatorConnections rows={connections} now={now} />,
  ),
  'admin-job-grants': shell('grants', null, <OperatorJobGrants panel={jobGrantPanel} now={now} />),
  'admin-audit': shell(
    'audit',
    null,
    <OperatorAudit rows={auditRows} filters={{ ...noFilters, days: '7' }} />,
  ),
  'admin-loading': shell(
    null,
    null,
    <div role="status" aria-busy="true">
      Loading operator information…
    </div>,
  ),
  'approve-single': (
    <OperatorApproveView
      item={appearance}
      expiry="expires in 2 days (Oct 3, 14:20 UTC)"
      panel={approvePanel(appearance)}
    />
  ),
  'approve-chat-request': (
    <OperatorApproveView
      item={appearance}
      expiry="expires in 2 days (Oct 3, 14:20 UTC)"
      notice="Requested from the chat. Your decision here is final for this request."
      panel={
        <ApproveInvoker
          id={appearance.id}
          argsHash={appearance.argsHash}
          label={appearance.title}
          decisionRequestId="req_1"
        />
      }
    />
  ),
  'approve-plan': (
    <OperatorApproveView
      item={plan}
      expiry="expires in 2 days (Oct 3, 13:05 UTC)"
      panel={approvePanel(plan)}
    />
  ),
  'approve-revert': (
    <OperatorApproveView
      item={revert}
      expiry="expires in 2 days (Oct 3, 14:20 UTC)"
      panel={approvePanel(revert)}
    />
  ),
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  mocks.searchParams = new URLSearchParams()
})

describe('operator screens', () => {
  it.each(Object.entries(screens))('%s has no axe violations', async (name, element) => {
    const { container } = render(element)
    const result = await axe.run(container, {
      // jsdom has no layout or compiled CSS; contrast is checked in the real browser run.
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    })
    expect(result.violations.map((v) => `${name}: ${v.id} ${v.nodes[0]?.html}`)).toEqual([])
  })

  it('keeps operator section links available during the pending transition', () => {
    render(screens['admin-loading']!)
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('link', { name: 'Audit' }).getAttribute('href')).toBe(
      '/admin/operator?tab=audit',
    )
    expect(screen.getByRole('link', { name: 'Audit' }).getAttribute('aria-current')).toBeNull()
  })

  it('selects a clicked tab immediately and replaces stale content while its route loads', () => {
    render(shell('inbox', 2, <OperatorInbox items={[plan]} now={now} />))
    fireEvent.click(screen.getByRole('link', { name: 'Audit' }))
    expect(screen.getByRole('link', { name: 'Audit' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('status').textContent).toContain('Loading operator information')
    expect(screen.queryByText('Set up Lakeside Aquarium and invite the owner')).toBeNull()
  })

  it('keeps the latest rapid tab choice and Escape clears a still-pending choice', () => {
    render(shell('inbox', 2, <OperatorInbox items={[plan]} now={now} />))
    fireEvent.click(screen.getByRole('link', { name: 'Audit' }))
    fireEvent.click(screen.getByRole('link', { name: 'Connections' }))
    expect(screen.getByRole('link', { name: 'Connections' }).getAttribute('aria-current')).toBe(
      'page',
    )
    expect(screen.getByText('Loading operator information…')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText('Loading operator information…')).toBeNull()
    expect(screen.getByRole('link', { name: 'Inbox (2)' }).getAttribute('aria-current')).toBe(
      'page',
    )
  })

  it('clears the pending indicator when browser navigation returns to the origin tab', () => {
    const { rerender } = render(shell('inbox', 2, <OperatorInbox items={[plan]} now={now} />))
    fireEvent.click(screen.getByRole('link', { name: 'Audit' }))
    mocks.searchParams = new URLSearchParams('tab=audit')
    rerender(shell('inbox', 2, <OperatorInbox items={[plan]} now={now} />))
    expect(screen.getByText('Loading operator information…')).toBeTruthy()

    mocks.searchParams = new URLSearchParams('tab=inbox')
    rerender(shell('inbox', 2, <OperatorInbox items={[plan]} now={now} />))
    expect(screen.queryByText('Loading operator information…')).toBeNull()
    expect(screen.getByRole('link', { name: 'Inbox (2)' }).getAttribute('aria-current')).toBe(
      'page',
    )
  })

  it('marks the requested destination as active as soon as the URL changes', () => {
    const { rerender } = render(shell('inbox', 0, <OperatorInbox items={[]} now={now} />))
    expect(screen.getByRole('link', { name: 'Inbox' }).getAttribute('aria-current')).toBe('page')

    mocks.searchParams = new URLSearchParams('tab=audit')
    rerender(shell('inbox', 0, <OperatorInbox items={[]} now={now} />))

    expect(screen.getByRole('link', { name: 'Audit' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Inbox' }).getAttribute('aria-current')).toBeNull()
  })

  it('writes static pages for the browser accessibility and screenshot run when asked', () => {
    const directory = process.env.OPERATOR_QA_HTML_DIR
    if (!directory) return
    mkdirSync(directory, { recursive: true })
    for (const [name, element] of Object.entries(screens)) {
      writeFileSync(
        join(directory, `${name}.html`),
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name} fixture</title><link rel="stylesheet" href="app.css"></head><body>${renderToStaticMarkup(element)}</body></html>`,
      )
    }
  })

  it('the approve page shows names, every plan step, and big Approve and Reject buttons', () => {
    render(screens['approve-plan']!)
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(5)
    expect(screen.getByRole('button', { name: /^Approve/u })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Reject/u })).toBeTruthy()
    expect(screen.getAllByText('Lakeside Aquarium Group').length).toBeGreaterThan(0)
  })

  it('the approve page shows the values a revert will restore', () => {
    render(screens['approve-revert']!)
    expect(screen.getByText('Will be restored (now, then restored)')).toBeTruthy()
    expect(screen.getByText('paper')).toBeTruthy()
  })

  it('locked autonomy rows cannot be switched and saving posts only real changes', async () => {
    mocks.post.mockResolvedValue({ saved: 1 })
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      mocks.post(path, JSON.parse(String(init.body)))
      return { json: async () => ({ saved: 1 }) }
    })
    render(<OperatorAutonomy rows={autonomyRows} />)
    const locked = screen.getByRole('switch', { name: 'Customer setup' }) as HTMLButtonElement
    expect(locked.disabled).toBe(true)
    fireEvent.click(screen.getByRole('switch', { name: 'CRM changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }))
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/api/operator/autonomy', {
        changes: [{ capability: 'crm:propose', mode: 'auto' }],
      }),
    )
    vi.unstubAllGlobals()
  })

  it('a chat approval request posts the decision to the single-use route, never the direct one', async () => {
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      mocks.post(path, JSON.parse(String(init.body)))
      return { json: async () => ({ id: 'x', status: 'APPLIED' }) }
    })
    render(screens['approve-chat-request']!)
    expect(screen.getByText(/Requested from the chat/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Approve/u }))
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/api/operator/decide', {
        decisionRequestId: 'req_1',
        argsHash: appearance.argsHash,
        decision: 'approve',
      }),
    )
    expect(mocks.post).not.toHaveBeenCalledWith('/api/operator/approve', expect.anything())
    vi.unstubAllGlobals()
  })

  it('job grants: lists status and remaining uses, revokes only active grants, and creates within the form bounds', async () => {
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      mocks.post(path, JSON.parse(String(init.body)))
      return { json: async () => ({ created: true }) }
    })
    render(screens['admin-job-grants']!)
    expect(screen.getByText('3 of 5 uses left')).toBeTruthy()
    expect(screen.getByText('Used up')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Revoke Weekly look refresh' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Revoke Old job' })).toBeNull()

    const create = screen.getByRole('button', { name: 'Create grant' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Job name'), { target: { value: 'Nightly look job' } })
    fireEvent.change(screen.getByLabelText('Connected app'), { target: { value: 'opc_1' } })
    fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'tenant_a' } })
    fireEvent.click(screen.getByLabelText('appearance.update'))
    expect(create.disabled).toBe(false)
    fireEvent.click(create)
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/api/operator/job-grants', {
        action: 'create',
        name: 'Nightly look job',
        clientId: 'opc_1',
        tenantId: 'tenant_a',
        kinds: ['appearance.update'],
        maxExecutions: 5,
        expiresInMinutes: 1440,
      }),
    )
    vi.unstubAllGlobals()
  })

  it('job grants: with nothing grantable the form is replaced by an explanation', () => {
    render(<OperatorJobGrants panel={{ ...jobGrantPanel, kinds: [] }} now={now} />)
    expect(screen.getByText(/nothing to create/u)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Create grant' })).toBeNull()
  })

  it('the connections tab links to arming and only active grants can be revoked', () => {
    render(screens['admin-connections']!)
    expect(screen.getAllByRole('link', { name: /Start connecting/u }).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Revoke Example Assistant' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Revoke Old Test Connector' })).toBeNull()
  })
})
