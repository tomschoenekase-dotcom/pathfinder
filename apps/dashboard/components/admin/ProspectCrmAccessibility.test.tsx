/* @vitest-environment jsdom */
import React from 'react'
import axe from 'axe-core'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProspectCreateForm } from './ProspectCreateForm'
import { ProspectImportWorkbench } from './ProspectImportWorkbench'
import { ProspectDirectory } from './ProspectDirectory'
import { ProspectOutreachCenter } from './ProspectOutreachCenter'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  history: [] as unknown[],
  listImports: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/prospects',
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      createProspect: { mutate: vi.fn() },
      listProspectImports: { query: mocks.listImports },
      getProspectImport: { query: vi.fn() },
      beginProspectImport: { mutate: vi.fn() },
      stageProspectImportRows: { mutate: vi.fn() },
      resolveProspectImportRow: { mutate: vi.fn() },
      approveProspectImport: { mutate: vi.fn() },
      commitProspectImportBatch: { mutate: vi.fn() },
    },
  }),
}))

describe('prospect CRM accessibility foundation', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('has no automated accessibility violations in manual prospect capture', async () => {
    const { container } = render(<ProspectCreateForm />)
    const result = await axe.run(container)
    expect(result.violations).toEqual([])
  })

  it('has no automated accessibility violations in the empty import workbench', async () => {
    mocks.listImports.mockResolvedValue(mocks.history)
    const { container } = render(<ProspectImportWorkbench />)
    const result = await axe.run(container)
    expect(result.violations).toEqual([])
  })

  it('has no automated accessibility violations in the operational directory', async () => {
    const { container } = render(
      <ProspectDirectory fixture={{ result: { items: [], nextCursor: null } as never }} />,
    )
    const result = await axe.run(container)
    expect(result.violations).toEqual([])
  })

  it('has no automated accessibility violations in the outreach readiness center', async () => {
    const { container } = render(
      <ProspectOutreachCenter
        fixture={{
          campaigns: [] as never,
          readiness: {
            deliveryEnabled: false,
            internalOnly: true,
            providerConfigured: false,
            provider: 'GMAIL',
            accounts: [],
            limits: { cohort: 5000, batch: 500 },
            policy: { agentsMayDraft: true, agentsMayApprove: false, agentsMaySend: false },
          } as never,
        }}
      />,
    )
    const result = await axe.run(container)
    expect(result.violations).toEqual([])
  })
})
