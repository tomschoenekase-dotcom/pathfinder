import type { NextConfig } from 'next'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveMonitoringContext } from '@pathfinder/config/monitoring'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const monitoringContext = resolveMonitoringContext(process.env, 'web')

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
  async headers() {
    return [
      {
        source: '/embed/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ]
  },
}

export default nextConfig
