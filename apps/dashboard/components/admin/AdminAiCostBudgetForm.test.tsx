/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  reset: vi.fn(),
  query: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      setAiCostBudget: { mutate: mocks.mutate },
      resetAiCostBudgetWindow: { mutate: mocks.reset },
      getAiCostBudget: { query: mocks.query },
    },
  }),
}))

import { AdminAiCostBudgetForm } from './AdminAiCostBudgetForm'

const initialState = {
  configured: true,
  enabled: true,
  startsAt: '2026-08-08T20:00:00.000Z',
  endsAt: '2027-08-09T20:00:00.000Z',
  hardLimitUsd: '100.00000000',
  remainingUsd: '90.00000000',
  reservedUsd: '2.00000000',
  committedUsd: '8.00000000',
  revision: 3,
  breachedAt: null,
  reason: 'Synthetic operating envelope',
  updatedAt: '2026-08-08T20:00:00.000Z',
  updatedBy: 'admin_1',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function codedError(code: string, message: string) {
  return Object.assign(new Error(message), { data: { code } })
}

function budgetResult(overrides: Record<string, unknown> = {}) {
  return {
    configured: true,
    enabled: true,
    startsAt: new Date(initialState.startsAt),
    endsAt: new Date(initialState.endsAt),
    hardLimitUsd: initialState.hardLimitUsd,
    remainingUsd: initialState.remainingUsd,
    reservedUsd: initialState.reservedUsd,
    committedUsd: initialState.committedUsd,
    epoch: 1,
    revision: 4,
    breachedAt: null,
    reason: initialState.reason,
    updatedAt: new Date('2026-08-08T20:01:00.000Z'),
    updatedBy: 'admin_1',
    version: 'gateway-v1',
    excludedProviderPaths: [],
    replayed: false,
    ...overrides,
  }
}

describe('AdminAiCostBudgetForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('shows exact counters and submits the displayed revision', async () => {
    mocks.mutate.mockResolvedValueOnce(budgetResult())
    render(<AdminAiCostBudgetForm tenantId="tenant_1" initialState={initialState} />)

    expect(screen.getByText(/including venue-scoped and tenant-wide generation/)).toBeTruthy()
    expect(screen.queryByText(/remain(?:s)? explicitly outside/i)).toBeNull()
    expect(screen.getByText('Committed', { exact: false }).textContent).toContain('$8.00000000')
    fireEvent.click(screen.getByRole('button', { name: 'Save AI budget' }))

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledOnce())
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        enabled: true,
        hardLimitUsd: '100.00000000',
        reason: 'Synthetic operating envelope',
        expectedRevision: 3,
      }),
    )
    expect(await screen.findByText('AI cost budget saved.')).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('uses structured conflict copy and locks mutations until an authoritative reload', async () => {
    mocks.mutate.mockRejectedValueOnce(codedError('CONFLICT', 'Opaque backend conflict.'))
    render(<AdminAiCostBudgetForm tenantId="tenant_1" initialState={initialState} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save AI budget' }))
    expect((await screen.findByRole('alert')).textContent).toContain('changed')
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: /Reload/ })).toBeTruthy()
    expect((screen.getByLabelText('Hard limit (USD)') as HTMLInputElement).disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Save AI budget' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('requires a persisted disabled state and confirmation before resetting an epoch', async () => {
    const disabledState = { ...initialState, enabled: false, reservedUsd: '0.00000000' }
    mocks.reset.mockResolvedValueOnce({
      configured: true,
      enabled: false,
      startsAt: new Date(disabledState.startsAt),
      endsAt: new Date(disabledState.endsAt),
      hardLimitUsd: '100.00000000',
      remainingUsd: '100.00000000',
      reservedUsd: '0.00000000',
      committedUsd: '0.00000000',
      epoch: 2,
      revision: 4,
      breachedAt: null,
      reason: disabledState.reason,
      updatedAt: new Date('2026-08-08T20:02:00.000Z'),
      updatedBy: 'admin_1',
      version: 'gateway-v1',
      excludedProviderPaths: [],
      reconciliation: { scanned: 1, settled: 1, raced: 0 },
    })
    render(<AdminAiCostBudgetForm tenantId="tenant_1" initialState={disabledState} />)

    fireEvent.click(screen.getByRole('button', { name: 'Reset disabled window' }))

    await waitFor(() => expect(mocks.reset).toHaveBeenCalledOnce())
    expect(window.confirm).toHaveBeenCalledOnce()
    expect(mocks.reset).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant_1', expectedRevision: 3 }),
    )
    expect(await screen.findByText(/AI cost budget window reset/)).toBeTruthy()
  })

  it('admits one immutable same-tick save and locks every field and action while pending', async () => {
    const pending = deferred<ReturnType<typeof budgetResult>>()
    mocks.mutate.mockReturnValueOnce(pending.promise)
    const disabledState = { ...initialState, enabled: false, reservedUsd: '0.00000000' }
    render(<AdminAiCostBudgetForm tenantId="tenant_1" initialState={disabledState} />)

    const enabled = screen.getByLabelText('Enforce this budget') as HTMLInputElement
    const limit = screen.getByLabelText('Hard limit (USD)') as HTMLInputElement
    const starts = screen.getByLabelText('Starts') as HTMLInputElement
    const ends = screen.getByLabelText('Ends') as HTMLInputElement
    const reason = screen.getByLabelText('Internal reason') as HTMLTextAreaElement
    fireEvent.click(enabled)
    fireEvent.change(limit, { target: { value: '125.50000000' } })
    fireEvent.change(reason, { target: { value: '  Immutable save reason  ' } })
    const expectedStartsAt = new Date(starts.value)
    const expectedEndsAt = new Date(ends.value)
    const save = screen.getByRole('button', { name: 'Save AI budget' })

    act(() => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      screen
        .getByRole('button', { name: 'Reset disabled window' })
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.mutate).toHaveBeenCalledOnce()
    expect(mocks.reset).not.toHaveBeenCalled()
    expect(window.confirm).not.toHaveBeenCalled()
    expect(mocks.mutate).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      enabled: true,
      startsAt: expectedStartsAt,
      endsAt: expectedEndsAt,
      hardLimitUsd: '125.50000000',
      reason: 'Immutable save reason',
      expectedRevision: 3,
    })
    expect(
      screen
        .getByRole('heading', { name: 'AI cost budget' })
        .closest('[aria-busy]')
        ?.getAttribute('aria-busy'),
    ).toBe('true')
    for (const field of [enabled, limit, starts, ends, reason]) expect(field.disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Saving/ }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(
      (screen.getByRole('button', { name: 'Reset disabled window' }) as HTMLButtonElement).disabled,
    ).toBe(true)

    pending.resolve(budgetResult({ hardLimitUsd: '125.50000000', reason: 'Immutable save reason' }))
    expect(await screen.findByText('AI cost budget saved.')).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('confirms and submits only one same-tick reset, then synchronizes returned editable state', async () => {
    const pending = deferred<ReturnType<typeof budgetResult>>()
    mocks.reset.mockReturnValueOnce(pending.promise)
    render(
      <AdminAiCostBudgetForm
        tenantId="tenant_1"
        initialState={{ ...initialState, enabled: false, reservedUsd: '0.00000000' }}
      />,
    )
    const reset = screen.getByRole('button', { name: 'Reset disabled window' })

    act(() => {
      reset.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      reset.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(window.confirm).toHaveBeenCalledOnce()
    expect(mocks.reset).toHaveBeenCalledOnce()
    expect((screen.getByRole('button', { name: /Resetting/ }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    pending.resolve(
      budgetResult({
        enabled: false,
        startsAt: new Date('2026-09-01T15:00:00.000Z'),
        endsAt: new Date('2027-09-01T15:00:00.000Z'),
        hardLimitUsd: '250.00000000',
        remainingUsd: '250.00000000',
        reservedUsd: '0.00000000',
        committedUsd: '0.00000000',
        revision: 5,
        reason: 'Returned reset reason',
        reconciliation: { scanned: 1, settled: 1, raced: 0 },
      }),
    )

    expect(await screen.findByText(/AI cost budget window reset/)).toBeTruthy()
    expect((screen.getByLabelText('Hard limit (USD)') as HTMLInputElement).value).toBe(
      '250.00000000',
    )
    expect((screen.getByLabelText('Internal reason') as HTMLTextAreaElement).value).toBe(
      'Returned reset reason',
    )
    expect((screen.getByLabelText('Enforce this budget') as HTMLInputElement).checked).toBe(false)
    expect(
      screen.getByText(
        (_, element) => element?.tagName === 'P' && element.textContent.includes('Revision 5'),
      ),
    ).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it.each([
    { error: codedError('CONFLICT', 'Opaque conflict.'), expected: 'changed' },
    {
      error: new Error('Budget changed according to untrusted message text.'),
      expected: 'could not be confirmed',
    },
  ])(
    'distinguishes structured mutation conflicts from generic outcomes: $expected',
    async ({ error, expected }) => {
      mocks.mutate.mockRejectedValueOnce(error)
      render(<AdminAiCostBudgetForm tenantId="tenant_1" initialState={initialState} />)
      fireEvent.click(screen.getByRole('button', { name: 'Save AI budget' }))

      expect((await screen.findByRole('alert')).textContent).toContain(expected)
      expect(screen.getByRole('button', { name: /Reload/ })).toBeTruthy()
      expect(mocks.refresh).toHaveBeenCalledOnce()
    },
  )

  it('reloads authoritative state explicitly and adopts its revision and editable fields', async () => {
    mocks.mutate.mockRejectedValueOnce(new Error('Opaque mutation failure.'))
    mocks.query.mockResolvedValueOnce(
      budgetResult({
        enabled: false,
        hardLimitUsd: '333.00000000',
        remainingUsd: '300.00000000',
        reservedUsd: '3.00000000',
        committedUsd: '30.00000000',
        revision: 9,
        reason: 'Authoritative reload reason',
      }),
    )
    render(<AdminAiCostBudgetForm tenantId="tenant_1" initialState={initialState} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save AI budget' }))
    const reload = await screen.findByRole('button', { name: /Reload/ })

    fireEvent.click(reload)
    await waitFor(() =>
      expect(mocks.query).toHaveBeenCalledWith(
        { tenantId: 'tenant_1' },
        { signal: expect.any(AbortSignal) },
      ),
    )
    expect(await screen.findByText(/reloaded/i)).toBeTruthy()
    expect((screen.getByLabelText('Hard limit (USD)') as HTMLInputElement).value).toBe(
      '333.00000000',
    )
    expect((screen.getByLabelText('Internal reason') as HTMLTextAreaElement).value).toBe(
      'Authoritative reload reason',
    )
    expect(
      screen.getByText(
        (_, element) => element?.tagName === 'P' && element.textContent.includes('Revision 9'),
      ),
    ).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Save AI budget' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('keeps a definitive save truthful when the best-effort router refresh throws', async () => {
    mocks.mutate.mockResolvedValueOnce(budgetResult({ revision: 8 }))
    mocks.refresh.mockImplementationOnce(() => {
      throw new Error('router unavailable')
    })
    render(<AdminAiCostBudgetForm tenantId="tenant_1" initialState={initialState} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save AI budget' }))

    expect(await screen.findByText('AI cost budget saved.')).toBeTruthy()
    expect(
      screen.getByText(
        (_, element) => element?.tagName === 'P' && element.textContent.includes('Revision 8'),
      ),
    ).toBeTruthy()
    expect(screen.queryByText(/could not be confirmed/)).toBeNull()
  })

  it('keeps unsafe mutations locked when authoritative reload also fails', async () => {
    mocks.mutate.mockRejectedValueOnce(new Error('transport unavailable'))
    mocks.query.mockRejectedValueOnce(new Error('read unavailable'))
    render(<AdminAiCostBudgetForm tenantId="tenant_1" initialState={initialState} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save AI budget' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Reload AI cost budget' }))

    expect((await screen.findByRole('alert')).textContent).toContain('could not be reloaded')
    expect(
      (screen.getByRole('button', { name: 'Save AI budget' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.getByRole('button', { name: 'Reload AI cost budget' })).toBeTruthy()
  })

  it('bounds authoritative budget reload and keeps mutations locked after the deadline', async () => {
    mocks.mutate.mockRejectedValueOnce(new Error('transport unavailable'))
    render(<AdminAiCostBudgetForm tenantId="tenant_1" initialState={initialState} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save AI budget' }))
    const reload = await screen.findByRole('button', { name: 'Reload AI cost budget' })
    vi.useFakeTimers()
    mocks.query.mockImplementation(() => new Promise(() => {}))
    fireEvent.click(reload)
    await act(async () => vi.advanceTimersByTimeAsync(0))
    const signal = mocks.query.mock.calls[0]?.[1]?.signal as AbortSignal
    await act(async () => vi.advanceTimersByTimeAsync(15_000))

    expect(signal.aborted).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('could not be reloaded in time')
    expect(
      (screen.getByRole('button', { name: 'Save AI budget' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Reload AI cost budget' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('invalidates an old completion synchronously when tenant and snapshot props change', async () => {
    const pending = deferred<ReturnType<typeof budgetResult>>()
    mocks.mutate.mockReturnValueOnce(pending.promise)
    const view = render(<AdminAiCostBudgetForm tenantId="tenant_1" initialState={initialState} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save AI budget' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledOnce())

    const replacement = {
      ...initialState,
      enabled: false,
      hardLimitUsd: '444.00000000',
      reason: 'Replacement tenant snapshot',
      revision: 12,
      updatedAt: '2026-08-09T20:00:00.000Z',
    }
    view.rerender(<AdminAiCostBudgetForm tenantId="tenant_2" initialState={replacement} />)
    pending.resolve(budgetResult({ hardLimitUsd: '999.00000000', revision: 99 }))
    await act(async () => pending.promise)

    expect((screen.getByLabelText('Hard limit (USD)') as HTMLInputElement).value).toBe(
      '444.00000000',
    )
    expect(
      screen.getByText(
        (_, element) => element?.tagName === 'P' && element.textContent.includes('Revision 12'),
      ),
    ).toBeTruthy()
    expect(screen.queryByText('AI cost budget saved.')).toBeNull()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('suppresses all late mutation effects after unmount', async () => {
    const pending = deferred<ReturnType<typeof budgetResult>>()
    mocks.mutate.mockReturnValueOnce(pending.promise)
    const view = render(<AdminAiCostBudgetForm tenantId="tenant_1" initialState={initialState} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save AI budget' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledOnce())
    view.unmount()

    pending.resolve(budgetResult())
    await act(async () => pending.promise)
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('releases the shared fence after validation failure and reset cancellation', async () => {
    vi.mocked(window.confirm).mockReturnValueOnce(false)
    mocks.mutate.mockResolvedValueOnce(budgetResult())
    const disabledState = { ...initialState, enabled: false, reservedUsd: '0.00000000' }
    render(<AdminAiCostBudgetForm tenantId="tenant_1" initialState={disabledState} />)
    const limit = screen.getByLabelText('Hard limit (USD)')
    fireEvent.change(limit, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save AI budget' }))
    expect(await screen.findByText(/Enter a limit/)).toBeTruthy()
    expect(mocks.mutate).not.toHaveBeenCalled()

    fireEvent.change(limit, { target: { value: '100.00000000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reset disabled window' }))
    expect(window.confirm).toHaveBeenCalledOnce()
    expect(mocks.reset).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Save AI budget' }))
    expect(await screen.findByText('AI cost budget saved.')).toBeTruthy()
    expect(mocks.mutate).toHaveBeenCalledOnce()
  })
})
