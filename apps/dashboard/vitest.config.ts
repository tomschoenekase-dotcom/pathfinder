import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: true,
    exclude: ['tests/browser/**', 'node_modules/**', '.next/**'],
  },
})
