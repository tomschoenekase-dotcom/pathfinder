/* @vitest-environment jsdom */
import React from 'react'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), post: vi.fn() }))

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/operator',
  useRouter: () => ({ refresh: mocks.refresh, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
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
import type {
  OperatorAuditRowView,
  OperatorAutonomyRow,
  OperatorConnectionRow,
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
  { capability: 'crm:propose', mode: 'ask', locked: false },
  { capability: 'crm:log', mode: 'auto', locked: false },
  { capability: 'venues:propose', mode: 'ask', locked: false },
  { capability: 'appearance:propose', mode: 'auto', locked: false },
  { capability: 'customers:propose', mode: 'ask', locked: true },
  { capability: 'support:propose', mode: 'ask', locked: false },
  { capability: 'operator:plan', mode: 'ask', locked: true },
  { capability: 'operator:revert', mode: 'ask', locked: true },
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

const noFilters = { eventType: '', outcome: '', tool: '', days: '' }

function shell(tab: OperatorTabId, inboxCount: number | null, content: React.ReactNode) {
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
  'admin-audit': shell(
    'audit',
    null,
    <OperatorAudit rows={auditRows} filters={{ ...noFilters, days: '7' }} />,
  ),
  'approve-single': (
    <OperatorApproveView
      item={appearance}
      expiry="expires in 2 days (Oct 3, 14:20 UTC)"
      panel={approvePanel(appearance)}
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
afterEach(() => cleanup())

describe('operator screens', () => {
  it.each(Object.entries(screens))('%s has no axe violations', async (name, element) => {
    const { container } = render(element)
    const result = await axe.run(container, {
      // jsdom has no layout or compiled CSS; contrast is checked in the real browser run.
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    })
    expect(result.violations.map((v) => `${name}: ${v.id} ${v.nodes[0]?.html}`)).toEqual([])
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
    const locked = screen.getByRole('switch', { name: 'Customer invites' }) as HTMLButtonElement
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

  it('the connections tab links to arming and only active grants can be revoked', () => {
    render(screens['admin-connections']!)
    expect(screen.getAllByRole('link', { name: /Start connecting/u }).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Revoke Example Assistant' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Revoke Old Test Connector' })).toBeNull()
  })
})
