import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  OPERATOR_MCP_PATH,
  parseExactOrigin,
  protectedResourceMetadataUrl,
  resolveOperatorConfig,
} from './config'
import {
  authorizationServerMetadata,
  handleAuthorizationServerMetadata,
  handleProtectedResourceMetadata,
  isOperatorApprover,
  protectedResourceMetadata,
  validateRegisteredRedirectUri,
} from './oauth'

const peppers = `k1:${randomBytes(32).toString('base64url')}`
const enabled = {
  OPERATOR_OAUTH_ENABLED: true,
  OPERATOR_OAUTH_ISSUER: 'https://app.example.com',
  OPERATOR_OAUTH_PEPPERS: peppers,
  OPERATOR_OAUTH_REDIRECT_ORIGINS: 'https://connector.example.com',
  OPERATOR_OAUTH_ALLOWED_USER_IDS: 'user_owner',
  RAILWAY_ENVIRONMENT: 'production',
}

function readyConfig() {
  const resolution = resolveOperatorConfig(enabled)
  if (resolution.status !== 'ready') throw new Error('expected ready')
  return resolution.config
}

describe('operator OAuth configuration', () => {
  it('is dark by default and fails closed when enabled but incomplete', () => {
    expect(resolveOperatorConfig({}).status).toBe('disabled')
    expect(resolveOperatorConfig({ ...enabled, OPERATOR_OAUTH_ENABLED: false }).status).toBe(
      'disabled',
    )
    for (const key of [
      'OPERATOR_OAUTH_ISSUER',
      'OPERATOR_OAUTH_PEPPERS',
      'OPERATOR_OAUTH_ALLOWED_USER_IDS',
    ] as const) {
      expect(resolveOperatorConfig({ ...enabled, [key]: undefined }).status).toBe('misconfigured')
    }
    expect(
      resolveOperatorConfig({
        ...enabled,
        OPERATOR_OAUTH_REDIRECT_ORIGINS: 'http://connector.example.com',
      }).status,
    ).toBe('misconfigured')
    expect(
      resolveOperatorConfig({ ...enabled, OPERATOR_OAUTH_ISSUER: 'https://app.example.com/path' })
        .status,
    ).toBe('misconfigured')
  })

  it('separates environments by token prefix and binds the audience to the exact resource', () => {
    const production = readyConfig()
    expect(production.environment).toBe('prd')
    expect(production.resource).toBe(`https://app.example.com${OPERATOR_MCP_PATH}`)
    const staging = resolveOperatorConfig({ ...enabled, RAILWAY_ENVIRONMENT: 'staging' })
    expect(staging.status === 'ready' && staging.config.environment).toBe('stg')
  })

  it('accepts only exact origins', () => {
    expect(parseExactOrigin('https://a.example.com')).toBe('https://a.example.com')
    expect(parseExactOrigin('https://a.example.com/')).toBe('https://a.example.com')
    expect(parseExactOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    for (const bad of [
      'http://a.example.com',
      'https://u@a.example.com',
      'https://a.example.com/x',
      'https://a.example.com?x=1',
      'nope',
    ]) {
      expect(parseExactOrigin(bad)).toBeNull()
    }
  })
})

describe('redirect URI registration', () => {
  const config = readyConfig()
  const good = 'https://connector.example.com/oauth/callback'

  it('accepts an exact HTTPS URI on an allowlisted origin and loopback HTTP for CLIs', () => {
    expect(validateRegisteredRedirectUri(good, config)).toBe(good)
    expect(validateRegisteredRedirectUri('http://127.0.0.1:43123/callback', config)).toBe(
      'http://127.0.0.1:43123/callback',
    )
    expect(validateRegisteredRedirectUri('http://localhost:8765/cb', config)).toBe(
      'http://localhost:8765/cb',
    )
  })

  it.each([
    ['a subdomain', 'https://evil.connector.example.com/oauth/callback'],
    ['a look-alike host', 'https://connector.example.com.evil.test/oauth/callback'],
    ['a different port', 'https://connector.example.com:8443/oauth/callback'],
    ['userinfo', 'https://connector.example.com@evil.test/oauth/callback'],
    ['userinfo on the allowed host', 'https://user@connector.example.com/oauth/callback'],
    ['a fragment', `${good}#frag`],
    ['plain HTTP on the allowed host', 'http://connector.example.com/oauth/callback'],
    ['non-canonical form', 'HTTPS://connector.example.com/oauth/callback'],
    ['a custom scheme', 'myapp://callback'],
    ['a javascript URI', 'javascript:alert(1)'],
    ['whitespace', `${good} `],
  ])('rejects %s', (_label, uri) => {
    expect(validateRegisteredRedirectUri(uri, config)).toBeNull()
  })
})

describe('authorization server and resource metadata', () => {
  const config = readyConfig()

  it('advertises S256-only public clients and the exact resource', () => {
    const metadata = authorizationServerMetadata(config)
    expect(metadata.issuer).toBe('https://app.example.com')
    expect(metadata.code_challenge_methods_supported).toEqual(['S256'])
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(['none'])
    expect(metadata.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
    expect(metadata.registration_endpoint).toBe('https://app.example.com/oauth/register')
    const resource = protectedResourceMetadata(config)
    expect(resource.resource).toBe('https://app.example.com/api/operator/mcp')
    expect(resource.authorization_servers).toEqual(['https://app.example.com'])
    expect(resource.bearer_methods_supported).toEqual(['header'])
    expect(protectedResourceMetadataUrl(config)).toBe(
      'https://app.example.com/.well-known/oauth-protected-resource/api/operator/mcp',
    )
  })

  it('returns 404 while disabled and 503 while misconfigured', async () => {
    expect(
      handleAuthorizationServerMetadata({ resolveConfig: () => ({ status: 'disabled' }) }).status,
    ).toBe(404)
    expect(
      handleProtectedResourceMetadata({
        resolveConfig: () => ({ status: 'misconfigured', reason: 'X' }),
      }).status,
    ).toBe(503)
    const ok = handleProtectedResourceMetadata({
      resolveConfig: () => ({ status: 'ready', config }),
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ resource: config.resource })
  })
})

describe('operator approver identity', () => {
  const config = readyConfig()
  it('requires both PLATFORM_ADMIN and the allowlist', () => {
    expect(
      isOperatorApprover(config, { userId: 'user_owner', platformRole: 'PLATFORM_ADMIN' }),
    ).toBe(true)
    expect(isOperatorApprover(config, { userId: 'user_owner', platformRole: undefined })).toBe(
      false,
    )
    expect(
      isOperatorApprover(config, { userId: 'user_other', platformRole: 'PLATFORM_ADMIN' }),
    ).toBe(false)
    expect(isOperatorApprover(config, { userId: null, platformRole: 'PLATFORM_ADMIN' })).toBe(false)
  })
})
