import assert from 'node:assert/strict'
import test from 'node:test'

import {
  auditPublicSurfaceManifest,
  discoverHttpMethods,
  discoverPublicTrpcSurfaces,
  discoverStringArray,
  isNextRouteModuleName,
  validateCanonicalApiPackageExports,
  validateCanonicalAppRouterExports,
  validateCanonicalProcedureBuilders,
  validateTrpcTransportBinding,
} from './lib/public-surface-inventory.mjs'

function fixtureModules(chatSource) {
  return new Map([
    [
      'packages/api/src/root.ts',
      `
        import { publicProcedure, tenantProcedure } from './trpc'
        import { chatRouter } from './routers/chat'
        export const appRouter = router({
          chat: chatRouter,
          health: publicProcedure.query(() => ({ ok: true })),
          privateRead: tenantProcedure.query(() => null),
        })
      `,
    ],
    ['packages/api/src/routers/chat.ts', chatSource],
    [
      'packages/api/src/trpc.ts',
      `
        export const publicProcedure = t.procedure
        export const tenantProcedure = t.procedure.use(requireAuth).use(requireTenant)
      `,
    ],
  ])
}

const admittedChat = `
  import { publicProcedure } from '../trpc'
  const admittedChatSendProcedure = publicProcedure
    .input(schema)
    .use(requireGlobalAi)
  export const chatRouter = router({
    send: admittedChatSendProcedure.mutation(() => null),
  })
`

test('discovers mounted public procedures and resolves a local admitted builder', () => {
  const result = discoverPublicTrpcSurfaces(
    fixtureModules(admittedChat),
    'packages/api/src/root.ts',
  )

  assert.deepEqual(result, {
    procedures: [
      { path: 'chat.send', kind: 'mutation', exposure: 'public-ai' },
      { path: 'health', kind: 'query', exposure: 'public' },
    ],
    violations: [],
  })
})

test('resolves imported procedure wrappers and merged routers', () => {
  const modules = fixtureModules(`
    import { wrappedPublic } from '../wrappers'
    export const chatRouter = router({ send: wrappedPublic.mutation(() => null) })
  `)
  modules.set(
    'packages/api/src/root.ts',
    `
      import { chatRouter } from './routers/chat'
      import { healthRouter } from './routers/health'
      export const appRouter = mergeRouters(chatRouter, healthRouter)
    `,
  )
  modules.set(
    'packages/api/src/routers/health.ts',
    `
      import { tenantProcedure } from '../trpc'
      export const healthRouter = router({ privateRead: tenantProcedure.query(() => null) })
    `,
  )
  modules.set(
    'packages/api/src/wrappers.ts',
    `
      import { publicProcedure } from './trpc'
      export const wrappedPublic = publicProcedure.input(schema)
    `,
  )
  modules.set(
    'packages/api/src/trpc.ts',
    `
      export const publicProcedure = t.procedure
      export const tenantProcedure = t.procedure.use(requireAuth).use(requireTenant)
    `,
  )

  assert.deepEqual(discoverPublicTrpcSurfaces(modules, 'packages/api/src/root.ts'), {
    procedures: [{ path: 'send', kind: 'mutation', exposure: 'public' }],
    violations: [],
  })
})

test('fails closed on aliased public builders and dynamic router entries', () => {
  const aliased = discoverPublicTrpcSurfaces(
    fixtureModules(`
      import { publicProcedure as open } from '../trpc'
      export const chatRouter = router({ send: open.mutation(() => null) })
    `),
    'packages/api/src/root.ts',
  )
  assert.ok(aliased.violations.some((violation) => violation.includes('imported through alias')))

  const spread = discoverPublicTrpcSurfaces(
    fixtureModules(`
      const hidden = { send: publicProcedure.mutation(() => null) }
      export const chatRouter = router({ ...hidden })
    `),
    'packages/api/src/root.ts',
  )
  assert.ok(
    spread.violations.some((violation) => violation.includes('static property assignments')),
  )

  const unknown = discoverPublicTrpcSurfaces(
    fixtureModules(`
      export const chatRouter = router({ send: unknownProcedure.mutation(() => null) })
    `),
    'packages/api/src/root.ts',
  )
  assert.ok(
    unknown.violations.some((violation) => violation.includes('cannot resolve procedure exposure')),
  )
})

test('inventories explicit HTTP exports and rejects route modules without one', () => {
  for (const name of ['route.ts', 'route.js', 'route.tsx', 'route.mjs', 'route.cts']) {
    assert.equal(isNextRouteModuleName(name), true)
  }
  assert.equal(isNextRouteModuleName('route.test.ts'), false)
  assert.deepEqual(
    discoverHttpMethods('const handler = () => null; export { handler as GET, handler as POST }'),
    { methods: ['GET', 'POST'], violations: [] },
  )
  assert.deepEqual(discoverHttpMethods('export async function DELETE() {}'), {
    methods: ['DELETE'],
    violations: [],
  })
  assert.ok(
    discoverHttpMethods('export const runtime = "nodejs"').violations.some((violation) =>
      violation.includes('no explicit HTTP method'),
    ),
  )
  assert.ok(
    discoverHttpMethods(
      "const handler = () => null; export { handler as GET }; export * from './extra'",
    ).violations.some((violation) => violation.includes('statically named')),
  )
})

test('pins canonical procedure-builder middleware chains', () => {
  const canonical = `
    export const publicProcedure = t.procedure
    export const publicAiProcedure = publicProcedure.use(requireGlobalAi)
    export const protectedProcedure = t.procedure.use(requireAuth)
    export const tenantProcedure = t.procedure.use(requireAuth).use(requireTenant)
    export const adminProcedure = t.procedure.use(requireAuth).use(requirePlatformAdminMiddleware)
    export const adminAiProcedure = adminProcedure.use(requireGlobalAi)
  `
  assert.deepEqual(validateCanonicalProcedureBuilders(canonical), [])
  assert.ok(
    validateCanonicalProcedureBuilders(
      canonical.replace('t.procedure.use(requireAuth).use(requireTenant)', 't.procedure'),
    ).some((violation) => violation.includes('tenantProcedure')),
  )
})

test('pins the package appRouter export to the inventoried root', () => {
  const canonical = {
    rootSource: 'export const appRouter = router({})',
    indexSource: "export { appRouter } from './root'",
  }
  assert.deepEqual(validateCanonicalAppRouterExports(canonical), [])
  assert.ok(
    validateCanonicalAppRouterExports({
      ...canonical,
      indexSource: "export { rogueRouter as appRouter } from './rogue'",
    }).some((violation) => violation.includes('re-export appRouter')),
  )
  assert.deepEqual(
    validateCanonicalApiPackageExports({
      name: '@pathfinder/api',
      exports: { '.': './src/index.ts' },
    }),
    [],
  )
  assert.ok(
    validateCanonicalApiPackageExports({
      name: '@pathfinder/api',
      exports: { '.': './src/rogue.ts' },
    }).some((violation) => violation.includes('canonical package export')),
  )
})

test('pins tRPC HTTP transports to the canonical appRouter', () => {
  const canonical = `
    import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
    import { appRouter } from '@pathfinder/api'
    const handler = (req) => fetchRequestHandler({ req, router: appRouter })
    export { handler as GET, handler as POST }
  `
  assert.deepEqual(validateTrpcTransportBinding(canonical), [])
  assert.ok(
    validateTrpcTransportBinding(
      canonical.replace('router: appRouter', 'router: rogueRouter'),
    ).some((violation) => violation.includes('canonical appRouter')),
  )
  assert.ok(
    validateTrpcTransportBinding(
      canonical.replace('{ appRouter }', '{ appRouter as publicRouter }'),
    ).some((violation) => violation.includes('canonical appRouter')),
  )
  const decoy = `
    import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
    import { appRouter } from '@pathfinder/api'
    import { rogueFetch, rogueRouter } from './rogue'
    void fetchRequestHandler({ router: appRouter })
    const handler = (req) => rogueFetch({ req, router: rogueRouter })
    export { handler as GET, handler as POST }
  `
  assert.ok(
    validateTrpcTransportBinding(decoy).some((violation) =>
      violation.includes('exported GET must invoke canonical'),
    ),
  )
  assert.ok(
    validateTrpcTransportBinding(
      canonical.replace('(req) =>', '(fetchRequestHandler, req) =>'),
    ).some((violation) => violation.includes('must not be shadowed')),
  )
  assert.ok(
    validateTrpcTransportBinding(
      canonical.replace(
        '{ req, router: appRouter }',
        '{ req, router: appRouter, ...rogueOptions }',
      ),
    ).some((violation) => violation.includes('static unique transport options')),
  )
})

test('requires a static dashboard public-path allowlist', () => {
  assert.deepEqual(
    discoverStringArray("const PUBLIC_ROUTES = ['/api/webhooks/clerk']", 'PUBLIC_ROUTES'),
    {
      values: ['/api/webhooks/clerk'],
      violations: [],
    },
  )
  assert.ok(
    discoverStringArray('const PUBLIC_ROUTES = buildRoutes()', 'PUBLIC_ROUTES').violations.some(
      (violation) => violation.includes('static array'),
    ),
  )
})

test('reconciles exact inventories and rejects missing, stale, and reclassified entries', () => {
  const discoveredTrpc = [
    { path: 'chat.send', kind: 'mutation', exposure: 'public-ai' },
    { path: 'health', kind: 'query', exposure: 'public' },
  ]
  const discoveredHttp = [{ source: 'apps/web/app/api/health/route.ts', methods: ['GET'] }]
  const manifest = {
    version: 1,
    trpc: discoveredTrpc.map((entry) => ({
      ...entry,
      controlProfile: entry.path === 'chat.send' ? 'bounded-ai-write' : 'static-public-liveness',
      behavioralEvidence: [],
      exceptionReason: 'fixture',
    })),
    http: [
      {
        ...discoveredHttp[0],
        exposure: 'intentional-public',
        controlProfile: 'bounded-public-health',
        behavioralEvidence: [],
        exceptionReason: 'fixture',
      },
    ],
    dashboardPublicApiPaths: ['/api/webhooks/clerk'],
  }
  const input = {
    discoveredTrpc,
    discoveredHttp,
    publicApiPaths: ['/api/webhooks/clerk'],
    manifest,
  }

  assert.deepEqual(auditPublicSurfaceManifest(input), [])
  assert.ok(
    auditPublicSurfaceManifest({
      ...input,
      manifest: { ...manifest, trpc: manifest.trpc.slice(0, 1) },
    }).includes('tRPC public inventory drift'),
  )
  assert.ok(
    auditPublicSurfaceManifest({
      ...input,
      manifest: {
        ...manifest,
        trpc: manifest.trpc.map((entry) =>
          entry.path === 'chat.send' ? { ...entry, exposure: 'public' } : entry,
        ),
      },
    }).includes('tRPC public inventory drift'),
  )
  assert.ok(
    auditPublicSurfaceManifest({ ...input, publicApiPaths: [] }).includes(
      'dashboard public API allowlist drift',
    ),
  )
  assert.ok(
    auditPublicSurfaceManifest({
      ...input,
      manifest: {
        ...manifest,
        trpc: manifest.trpc.map((entry) =>
          entry.path === 'chat.send'
            ? { ...entry, controlProfile: 'bounded-session-write' }
            : entry,
        ),
      },
    }).some((violation) => violation.includes('control profile is incompatible')),
  )
  assert.ok(
    auditPublicSurfaceManifest({
      ...input,
      manifest: {
        ...manifest,
        trpc: manifest.trpc.map((entry) =>
          entry.path === 'chat.send'
            ? { ...entry, behavioralEvidence: ['../outside.test.ts'] }
            : entry,
        ),
      },
    }).some((violation) => violation.includes('invalid behavioral evidence path')),
  )

  const machineCredentialIngress = {
    source: 'apps/dashboard/app/api/agent-bridge/[tenantId]/[venueId]/route.ts',
    methods: ['POST'],
    exposure: 'machine-credential-authenticated-public-ingress',
    controlProfile: 'bounded-machine-credential-ingress',
    behavioralEvidence: [],
    exceptionReason: 'fixture',
  }
  assert.deepEqual(
    auditPublicSurfaceManifest({
      discoveredTrpc,
      discoveredHttp: [
        discoveredHttp[0],
        { source: machineCredentialIngress.source, methods: machineCredentialIngress.methods },
      ],
      publicApiPaths: ['/api/agent-bridge', '/api/webhooks/clerk'],
      manifest: {
        ...manifest,
        http: [...manifest.http, machineCredentialIngress],
        dashboardPublicApiPaths: ['/api/agent-bridge', '/api/webhooks/clerk'],
      },
    }),
    [],
  )
  assert.ok(
    auditPublicSurfaceManifest({
      discoveredTrpc,
      discoveredHttp: [
        discoveredHttp[0],
        { source: machineCredentialIngress.source, methods: machineCredentialIngress.methods },
      ],
      publicApiPaths: ['/api/agent-bridge', '/api/webhooks/clerk'],
      manifest: {
        ...manifest,
        http: [
          ...manifest.http,
          { ...machineCredentialIngress, controlProfile: 'bounded-signed-webhook' },
        ],
        dashboardPublicApiPaths: ['/api/agent-bridge', '/api/webhooks/clerk'],
      },
    }).some((violation) => violation.includes('control profile is incompatible')),
  )
})
