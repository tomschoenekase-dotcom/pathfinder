import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    passWithNoTests: true,
    // Keep worker suites within the hosted fixture runner's memory budget.
    minWorkers: 1,
    maxWorkers: 2,
  },
})
