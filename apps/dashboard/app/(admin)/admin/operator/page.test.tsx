/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  caller: {
    admin: {
      operatorInbox: vi.fn(),
      operatorAutonomy: vi.fn(),
      operatorConnections: vi.fn(),
      operatorAudit: vi.fn(),
      operatorJobGrants: vi.fn(),
    },
  },
  logError: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_NOT_FOUND' })
  },
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('@pathfinder/config/logger', () => ({ logger: { error: mocks.logError } }))
vi.mock('../../../../lib/operator-session', () => ({
  resolveOperatorSession: mocks.session,
}))
vi.mock('../../../../lib/admin-caller', () => ({
  createAdminCaller: async () => mocks.caller,
}))

import OperatorAdminPage from './page'

async function renderTab(tab?: string) {
  const element = await OperatorAdminPage({
    searchParams: Promise.resolve(tab ? { tab } : {}),
  })
  return render(element)
}

function prismaError(code: string) {
  // tRPC wraps the original error as `cause`.
  return Object.assign(new Error('INTERNAL_SERVER_ERROR'), {
    code: 'INTERNAL_SERVER_ERROR',
    cause: Object.assign(new Error('column does not exist'), { code }),
  })
}

describe('/admin/operator page data path', () => {
  beforeEach(() => {
    mocks.session.mockResolvedValue({ status: 'ok', userId: 'user_1', config: {} })
    mocks.caller.admin.operatorInbox.mockResolvedValue([])
    mocks.caller.admin.operatorAutonomy.mockResolvedValue([])
    mocks.caller.admin.operatorConnections.mockResolvedValue([])
    mocks.caller.admin.operatorAudit.mockResolvedValue([])
    mocks.caller.admin.operatorJobGrants.mockResolvedValue({
      grants: [],
      clients: [],
      tenants: [],
      kinds: [],
    })
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows the genuine empty state only when the inbox read succeeded', async () => {
    await renderTab()
    expect(screen.getByText('Nothing is waiting for you')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders an error panel, not the empty state, when the inbox read fails', async () => {
    mocks.caller.admin.operatorInbox.mockRejectedValue(prismaError('P2022'))
    await renderTab()
    expect(screen.getByRole('alert').textContent).toContain('Inbox section could not load')
    expect(screen.getByRole('alert').textContent).toContain('missing a recent update')
    expect(screen.queryByText('Nothing is waiting for you')).toBeNull()
    // The page frame and the other sections stay usable, and no count implies an empty queue.
    expect(screen.getByRole('heading', { name: 'Dot operator' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Connections' }).getAttribute('href')).toBe(
      '/admin/operator?tab=connections',
    )
    expect(screen.getByRole('link', { name: 'Try loading again' }).getAttribute('href')).toBe(
      '/admin/operator?tab=inbox',
    )
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'operator.panel.load_failed',
        panel: 'inbox',
        category: 'schema_not_ready',
        errorCode: 'P2022',
      }),
    )
  })

  it.each([
    ['autonomy', 'operatorAutonomy', 'Autonomy'],
    ['connections', 'operatorConnections', 'Connections'],
    ['audit', 'operatorAudit', 'Audit'],
    ['grants', 'operatorJobGrants', 'Job grants'],
  ] as const)(
    'fails the %s tab as an error panel and leaves other tabs working',
    async (tab, method, label) => {
      mocks.caller.admin[method].mockRejectedValue(prismaError('P1001'))
      await renderTab(tab)
      expect(screen.getByRole('alert').textContent).toContain(`${label} section could not load`)
      expect(screen.getByRole('alert').textContent).toContain('database did not respond')
      cleanup()
      // Another tab renders normally while this source is still failing.
      await renderTab('inbox')
      expect(screen.getByText('Nothing is waiting for you')).toBeTruthy()
      expect(screen.queryByRole('alert')).toBeNull()
    },
  )

  it('categorises unexpected failures and does not put the raw message in log metadata', async () => {
    mocks.caller.admin.operatorInbox.mockRejectedValue(new Error('boom with secret@example.com'))
    await renderTab('inbox')
    expect(screen.getByRole('alert').textContent).toContain('unexpected')
    expect(screen.getByRole('alert').textContent).not.toContain('secret@example.com')
    expect(mocks.logError.mock.calls[0]![0]).toMatchObject({
      category: 'unexpected',
      panel: 'inbox',
    })
  })

  it('still treats an absent operator (NOT_FOUND) as a 404 rather than a panel error', async () => {
    mocks.caller.admin.operatorInbox.mockRejectedValue(
      Object.assign(new Error('Not found'), { code: 'NOT_FOUND' }),
    )
    await expect(renderTab()).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.logError).not.toHaveBeenCalled()
  })

  it('does not swallow Next.js control-flow errors', async () => {
    mocks.session.mockResolvedValue({ status: 'disabled' })
    await expect(renderTab()).rejects.toMatchObject({ digest: 'NEXT_NOT_FOUND' })
  })

  it('sends a non-allowlisted account to the not allowed state without reading any data', async () => {
    mocks.session.mockResolvedValue({ status: 'forbidden' })
    await renderTab()
    expect(screen.getByText('Not allowed')).toBeTruthy()
    expect(mocks.caller.admin.operatorInbox).not.toHaveBeenCalled()
  })
})
