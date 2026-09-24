import { createTRPCUntypedClient, loggerLink, TRPCClientError } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { describe, expect, it, vi } from 'vitest'
import { shouldLogDashboardOperation } from './trpc-log-policy'

describe('dashboard credential transport logging boundary', () => {
  it.each([false, true])(
    'withholds CRM plaintext inputs and successful results (development=%s)',
    async (development) => {
      const logger = vi.fn()
      const client = createTRPCUntypedClient({
        links: [
          loggerLink({
            logger,
            enabled: (operation) => shouldLogDashboardOperation(operation, development),
          }),
          () => () =>
            observable((observer) => {
              observer.next({ result: { data: { body: 'FICTIONAL_PRIVATE_REPLY_SENTINEL' } } })
              observer.complete()
            }),
        ],
      })
      await client.query('admin.getProspectSalesWorkflow', { venueId: 'synthetic' })
      for (const path of [
        'admin.prepareReviewProspectSales',
        'admin.readProspectReplyContent',
        'admin.retainProspectReplyContent',
      ]) {
        await client.mutation(path, { text: 'FICTIONAL_PRIVATE_GUIDE_SENTINEL' })
      }
      expect(logger).not.toHaveBeenCalled()
    },
  )

  it.each([false, true])(
    'never logs provider key writes even on failure (development=%s)',
    async (development) => {
      const logger = vi.fn()
      const client = createTRPCUntypedClient({
        links: [
          loggerLink({
            logger,
            enabled: (operation) => shouldLogDashboardOperation(operation, development),
          }),
          () => () =>
            observable((observer) => {
              observer.error(new TRPCClientError('synthetic failure'))
            }),
        ],
      })
      for (const path of ['admin.createAiProviderConnection', 'admin.reviseAiProviderConnection']) {
        await expect(
          client.mutation(path, { apiKey: 'FICTIONAL_SECRET_SENTINEL' }),
        ).rejects.toThrow('synthetic failure')
      }
      expect(logger).not.toHaveBeenCalled()
      await expect(client.query('admin.getClient', {})).rejects.toThrow('synthetic failure')
      expect(logger).toHaveBeenCalled()
      expect(JSON.stringify(logger.mock.calls)).not.toContain('FICTIONAL_SECRET_SENTINEL')
    },
  )

  it('does not log an operation without a known path or a successful production result', () => {
    expect(
      shouldLogDashboardOperation({ direction: 'down', result: new Error('unknown') }, true),
    ).toBe(false)
    expect(
      shouldLogDashboardOperation(
        { path: 'admin.getClient', direction: 'down', result: {} },
        false,
      ),
    ).toBe(false)
  })
})
