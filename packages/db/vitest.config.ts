import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      exclude: ['src/**/*.test.ts'],
      include: ['src/middleware/tenant-isolation.ts'],
      provider: 'istanbul',
      reporter: ['text'],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
    environment: 'node',
    passWithNoTests: true,
  },
})
