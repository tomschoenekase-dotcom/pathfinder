import { TRPCError } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TRPCContext } from './context'

const context: TRPCContext = {
  db: {} as TRPCContext['db'],
  headers: new Headers(),
  session: {
    userId: null,
    activeTenantId: null,
    role: null,
    isPlatformAdmin: false,
  },
}

type ErrorPath = 'unexpected' | 'explicit-server' | 'unsafe-bad-request' | 'public-bad-request'

async function requestError(params: {
  nodeEnvironment: 'production' | 'development'
  path: ErrorPath
  failContext?: boolean
}): Promise<{ status: number; body: string }> {
  vi.stubEnv('NODE_ENV', params.nodeEnvironment)
  vi.resetModules()
  const { publicTRPCError, router, t } = await import('./core')
  const testRouter = router({
    unexpected: t.procedure.query(() => {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'sensitive database hostname and internal detail',
        cause: { secret: 'sensitive nested cause' },
      })
    }),
    'explicit-server': t.procedure.query(() => {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'sensitive provider failure detail',
      })
    }),
    'unsafe-bad-request': t.procedure.query(() => {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'sensitive validation detail' })
    }),
    'public-bad-request': t.procedure.query(() => {
      throw publicTRPCError({ code: 'BAD_REQUEST', message: 'Public input is invalid' })
    }),
  })
  const response = await fetchRequestHandler({
    endpoint: '/trpc',
    req: new Request(`https://pathfinder.test/trpc/${params.path}`),
    router: testRouter,
    createContext: async () => {
      if (params.failContext) throw new Error('sensitive context initialization detail')
      return context
    },
  })
  return { status: response.status, body: await response.text() }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('tRPC production error boundary', () => {
  it.each(['unexpected', 'explicit-server'] as const)(
    'masks %s server failures in an actual HTTP response',
    async (path) => {
      const response = await requestError({ nodeEnvironment: 'production', path })
      expect(response.status).toBe(500)
      expect(response.body).toContain('Internal server error')
      expect(response.body).not.toMatch(/sensitive|hostname|provider failure|nested cause|stack/iu)
    },
  )

  it('masks unmarked 4xx messages in production', async () => {
    const response = await requestError({
      nodeEnvironment: 'production',
      path: 'unsafe-bad-request',
    })
    expect(response.status).toBe(400)
    expect(response.body).toContain('Internal server error')
    expect(response.body).not.toContain('sensitive validation detail')
  })

  it('preserves explicitly marked client-safe messages in production', async () => {
    const response = await requestError({
      nodeEnvironment: 'production',
      path: 'public-bad-request',
    })
    expect(response.status).toBe(400)
    expect(response.body).toContain('Public input is invalid')
    expect(response.body).not.toContain('stack')
  })

  it('masks failures raised while creating context', async () => {
    const response = await requestError({
      nodeEnvironment: 'production',
      path: 'unexpected',
      failContext: true,
    })
    expect(response.status).toBe(500)
    expect(response.body).toContain('Internal server error')
    expect(response.body).not.toMatch(/sensitive|context initialization|stack/iu)
  })

  it('allows only code and httpStatus in production error data', async () => {
    const response = await requestError({ nodeEnvironment: 'production', path: 'unexpected' })
    const payload = JSON.parse(response.body) as { error: { json: { data: object } } }
    expect(Object.keys(payload.error.json.data).sort()).toEqual(['code', 'httpStatus'])
    expect(response.body).not.toMatch(/nested cause|secret|path|stack/iu)
  })

  it('retains development diagnostics', async () => {
    const response = await requestError({ nodeEnvironment: 'development', path: 'unexpected' })
    expect(response.status).toBe(500)
    expect(response.body).toContain('sensitive database hostname and internal detail')
    expect(response.body).toContain('stack')
  })
})
