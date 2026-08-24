import type { NextConfig } from 'next'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveMonitoringContext } from '@pathfinder/config/monitoring'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const monitoringContext = resolveMonitoringContext(process.env, 'dashboard')

const nextConfig: NextConfig = {
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
  images: {
    dangerouslyAllowSVG: true,
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
  },
  outputFileTracingIncludes: {
    '/**': ['../../node_modules/.pnpm/@prisma+client*/**/*.node'],
  },
}

export default nextConfig
