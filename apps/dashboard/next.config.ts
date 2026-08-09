import type { NextConfig } from 'next'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveMonitoringContext } from '@pathfinder/config/monitoring'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const monitoringContext = resolveMonitoringContext(process.env, 'dashboard')

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: monitoringContext.environment,
    NEXT_PUBLIC_SENTRY_RELEASE: monitoringContext.release,
  },
  output: 'standalone',
  outputFileTracingRoot: workspaceRoot,
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
