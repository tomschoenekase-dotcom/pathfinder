import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: true,
    // Keep dashboard suites within the hosted fixture runner's memory budget.
    minWorkers: 1,
    maxWorkers: 2,
    exclude: [
      'tests/browser/**',
      'tests/visual/**',
      'tests/visitor-launch/**',
      'tests/visitor-performance/**',
      'tests/dashboard-performance/**',
      'node_modules/**',
      '.next/**',
    ],
  },
})
