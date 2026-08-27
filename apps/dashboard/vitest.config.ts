import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: true,
    exclude: [
      'tests/browser/**',
      'tests/visual/**',
      'tests/visitor-launch/**',
      'tests/visitor-performance/**',
      'node_modules/**',
      '.next/**',
    ],
  },
})
