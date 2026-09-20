import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: true,
    // Keep worker suites within the hosted fixture runner's memory budget.
    minWorkers: 1,
    maxWorkers: 2,
  },
})
