import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  './packages/analytics/vitest.config.ts',
  './packages/ai/vitest.config.ts',
  './packages/api/vitest.config.ts',
  './packages/auth/vitest.config.ts',
  './packages/config/vitest.config.ts',
  './packages/contracts/vitest.config.ts',
  './packages/db/vitest.config.ts',
  './packages/intake-engine/vitest.config.ts',
  './packages/jobs/vitest.config.ts',
  './packages/ui/vitest.config.ts',
])
