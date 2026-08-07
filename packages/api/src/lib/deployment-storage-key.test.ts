import { describe, expect, it } from 'vitest'

import { deploymentStorageKey, resolveDeploymentEnvironment } from './deployment-storage-key'

describe('deploymentStorageKey', () => {
  const key = 'media-ingestion/tenant/venue/project/archive.zip'

  it('preserves production object keys for backward compatibility', () => {
    expect(deploymentStorageKey('production', key)).toBe(key)
  })

  it('isolates staging and preview object keys', () => {
    expect(deploymentStorageKey('staging', key)).toBe(`staging/${key}`)
    expect(deploymentStorageKey('preview', key)).toBe(`preview/${key}`)
  })

  it('defaults local and test execution to staging', () => {
    expect(resolveDeploymentEnvironment(undefined, 'test')).toBe('staging')
  })

  it('refuses an absent or invalid environment in production', () => {
    expect(() => resolveDeploymentEnvironment(undefined, 'production')).toThrow()
    expect(() => resolveDeploymentEnvironment('wrong', 'production')).toThrow()
  })
})
