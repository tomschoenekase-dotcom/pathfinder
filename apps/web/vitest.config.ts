import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    exclude: [...configDefaults.exclude, '.next/**'],
    // Keep the visitor UI suite within its existing per-test timeouts when the
    // release gate runs multiple workspace packages on the same machine.
    maxWorkers: 2,
    passWithNoTests: true,
  },
})
