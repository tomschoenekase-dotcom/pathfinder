import type { NextConfig } from 'next'
import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveMonitoringContext } from '@pathfinder/config/monitoring'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const localFixtureAuth = process.env.TORCHIKO_LOCAL_FIXTURE_AUTH === '1'
if (localFixtureAuth) {
  if (process.env.NODE_ENV !== 'development') {
    throw new Error('Local fixture authentication is forbidden outside development')
  }
  const expectedArgs = ['dev', '--hostname', '127.0.0.1', '--port', '56346']
  const exactDevCommand = process.argv.slice(2).join('\\0') === expectedArgs.join('\\0')
  const exactNextWorker =
    process.env.NEXT_PRIVATE_WORKER === '1' &&
    process.argv.length === 2 &&
    /[\\/]next[\\/]dist[\\/]server[\\/]lib[\\/]start-server\.js$/u.test(process.argv[1] ?? '')
  if (!exactDevCommand && !exactNextWorker) {
    throw new Error('Local fixture authentication requires the exact loopback dev command')
  }
  if (
    process.env.TORCHIKO_LOCAL_FULL_STACK_NETWORK_GUARD !== '1' ||
    !process.env.NODE_OPTIONS?.includes('local-full-stack.mjs') ||
    (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for('torchiko.p14.egressGuardInstalled')
    ] !== true
  ) {
    throw new Error('Local fixture authentication requires the local egress guard')
  }
  if (
    readdirSync(dirname(fileURLToPath(import.meta.url))).some((name) =>
      /^\.env(?:\..+)?$/u.test(name),
    )
  ) {
    throw new Error('Local fixture authentication refuses app dotenv files')
  }
}
const monitoringContext = resolveMonitoringContext(process.env, 'dashboard')
const transportSecurityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
]

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  distDir: process.env.NEXT_DIST_DIR || '.next',
  env: {
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: monitoringContext.environment,
    NEXT_PUBLIC_SENTRY_RELEASE: monitoringContext.release,
  },
  output: 'standalone',
  outputFileTracingRoot: workspaceRoot,
  serverExternalPackages: [
    '@opentelemetry/instrumentation',
    '@sentry/nextjs',
    'require-in-the-middle',
  ],
  transpilePackages: ['@pathfinder/config'],
  webpack(config, context) {
    if (localFixtureAuth) {
      if (!context.dev) {
        throw new Error('Local fixture authentication is forbidden in a production build')
      }
      const fixtureRoot = resolve(workspaceRoot, 'packages/auth/src/local-fixture')
      config.resolve ??= {}
      config.resolve.alias = {
        ...config.resolve.alias,
        '@clerk/nextjs$': resolve(fixtureRoot, 'client.ts'),
        '@clerk/nextjs/server$': resolve(
          fixtureRoot,
          context.nextRuntime === 'edge' ? 'edge.ts' : 'server.ts',
        ),
      }
    }
    return config
  },
  images: {
    dangerouslyAllowSVG: true,
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
  },
  outputFileTracingIncludes: {
    '/**': [
      '../../node_modules/.pnpm/@prisma+client*/**/*.node',
      '../../node_modules/.pnpm/meriyah@*/node_modules/meriyah/**/*',
    ],
  },
  async headers() {
    return [{ source: '/:path*', headers: transportSecurityHeaders }]
  },
}

export default nextConfig
