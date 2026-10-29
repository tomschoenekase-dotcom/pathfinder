/** Revalidate the auth boundary's safe receipt before storing or replaying it. */
export function customerProviderDiagnostics(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const diagnostic = value as Record<string, unknown>
  if (diagnostic.provider !== 'clerk' || diagnostic.operation !== 'organization_create')
    return undefined
  const statuses = [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504]
  const codes = [
    'organization_limit_exceeded',
    'organization_membership_limit_exceeded',
    'resource_not_found',
    'form_param_format_invalid',
    'form_param_value_invalid',
    'form_param_missing',
    'form_identifier_exists',
    'authorization_invalid',
    'rate_limit_exceeded',
    'not_allowed_access',
    'internal_server_error',
  ]
  return {
    provider: 'clerk' as const,
    operation: 'organization_create' as const,
    httpStatus:
      typeof diagnostic.httpStatus === 'number' && statuses.includes(diagnostic.httpStatus)
        ? diagnostic.httpStatus
        : null,
    providerCode:
      typeof diagnostic.providerCode === 'string' && codes.includes(diagnostic.providerCode)
        ? diagnostic.providerCode
        : null,
  }
}

export function customerProviderDiagnosticsFromError(error: unknown) {
  return error && typeof error === 'object'
    ? customerProviderDiagnostics((error as Record<string, unknown>).providerDiagnostics)
    : undefined
}
