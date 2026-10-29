import { describe, expect, it } from 'vitest'
import {
  customerProviderDiagnostics,
  customerProviderDiagnosticsFromError,
} from './customer-provider-diagnostics'

describe('customer provider diagnostics projection', () => {
  it('copies only allowlisted status/code from the safe auth projection', () => {
    const safe = customerProviderDiagnostics({
      provider: 'clerk',
      operation: 'organization_create',
      httpStatus: 429,
      providerCode: 'rate_limit_exceeded',
      message: 'PRIVATE',
      metadata: 'PRIVATE',
    })
    expect(safe).toEqual({
      provider: 'clerk',
      operation: 'organization_create',
      httpStatus: 429,
      providerCode: 'rate_limit_exceeded',
    })
    expect(JSON.stringify(safe)).not.toContain('PRIVATE')
  })
  it('drops unknown statuses and codes and never inspects raw error bodies', () => {
    expect(
      customerProviderDiagnosticsFromError({
        status: 403,
        errors: [{ code: 'organization_limit_exceeded' }],
      }),
    ).toBeUndefined()
    expect(
      customerProviderDiagnostics({
        provider: 'clerk',
        operation: 'organization_create',
        httpStatus: '403',
        providerCode: 'PRIVATE',
      }),
    ).toEqual({
      provider: 'clerk',
      operation: 'organization_create',
      httpStatus: null,
      providerCode: null,
    })
    expect(
      customerProviderDiagnostics({ provider: 'other', operation: 'organization_create' }),
    ).toBeUndefined()
  })
})
