import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingIncludes: {
    '/**': ['../../node_modules/.pnpm/@prisma+client*/**/*.node'],
  },
}

export default nextConfig
