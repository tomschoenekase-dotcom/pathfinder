import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'

import {
  authenticatedSurfaceArtifactDirectory,
  parseHostedAuthenticatedSurfaceArgs,
  resolveSessionStatePath,
  validateAuthenticatedDashboardPolicy,
  validateAuthenticatedRouteEvidence,
  validateAuthenticatedSurfaceDestination,
  validateAuthenticatedSurfaceRoute,
  validateAuthenticatedSurfaceSamples,
} from '../apps/dashboard/scripts/measure-hosted-authenticated-surfaces.mjs'

const revision = 'a'.repeat(40)
const externalSession = path.resolve('..', 'authorized-staging-session.json')

test('requires exact revision, external session state, and sensitive-artifact acknowledgement', () => {
  assert.deepEqual(
    parseHostedAuthenticatedSurfaceArgs([
      '--revision',
      revision,
      '--session-state',
      externalSession,
      '--ack-sensitive-local-artifacts',
      'yes',
    ]),
    {
      revision,
      sessionState: externalSession,
      routes: ['/admin/operations', '/admin/directory', '/admin/prospects/outreach'],
    },
  )
  assert.throws(
    () =>
      parseHostedAuthenticatedSurfaceArgs([
        '--revision',
        revision,
        '--session-state',
        externalSession,
      ]),
    /acknowledgement-required/u,
  )
  assert.throws(() => resolveSessionStatePath('session.json'), /external-json/u)
})

test('allows only exact passive admin routes and the reviewed staging dashboard origin', () => {
  assert.equal(validateAuthenticatedSurfaceRoute('/admin/operations'), '/admin/operations')
  for (const route of ['/admin/operations?send=1', '/api/admin', '/../admin', 'https://evil.test'])
    assert.throws(() => validateAuthenticatedSurfaceRoute(route), /unsafe-authenticated-route/u)
  assert.equal(
    validateAuthenticatedDashboardPolicy({
      dashboardUrl: 'https://dashboard.example.test/',
      dashboardHost: 'dashboard.example.test',
    }),
    'https://dashboard.example.test',
  )
  assert.throws(
    () =>
      validateAuthenticatedDashboardPolicy({
        dashboardUrl: 'https://user:secret@dashboard.example.test/',
        dashboardHost: 'dashboard.example.test',
      }),
    /policy-origin-invalid/u,
  )
})

test('keeps sensitive artifacts in the gitignored revision directory', () => {
  const directory = authenticatedSurfaceArtifactDirectory(revision)
  assert.equal(path.basename(directory), revision)
  assert.match(directory.replaceAll('\\', '/'), /artifacts\/hosted-authenticated-surfaces/u)
  assert.throws(() => authenticatedSurfaceArtifactDirectory('short'), /exact-revision/u)
})

test('rejects unauthenticated redirects, browser failures, and missing screenshots', () => {
  const origin = 'https://dashboard.example.test'
  const valid = {
    requestedRoute: '/admin/operations',
    finalOrigin: origin,
    finalPath: '/admin/operations',
    mainLandmarkPresent: true,
    routeEvidence: [
      { id: 'founder-control-room-heading', visible: true },
      { id: 'queue-pause-state', visible: true },
    ],
    browserErrors: [],
    screenshotBytes: 100,
    screenshotSha256: 'b'.repeat(64),
  }
  assert.doesNotThrow(() => validateAuthenticatedSurfaceSamples([valid], origin, 1))
  assert.throws(
    () => validateAuthenticatedSurfaceSamples([{ ...valid, finalPath: '/sign-in' }], origin, 1),
    /session-unavailable/u,
  )
  assert.throws(
    () =>
      validateAuthenticatedSurfaceSamples(
        [{ ...valid, browserErrors: [{ kind: 'page-error' }] }],
        origin,
        1,
      ),
    /browser-errors/u,
  )
  assert.throws(
    () => validateAuthenticatedSurfaceSamples([{ ...valid, screenshotBytes: 0 }], origin, 1),
    /screenshot-missing/u,
  )
})

test('requires route-specific rendered evidence rather than a generic authenticated shell', () => {
  assert.doesNotThrow(() =>
    validateAuthenticatedRouteEvidence('/admin/directory', [
      { id: 'clients-heading', visible: true },
      { id: 'client-directory-search', visible: true },
    ]),
  )
  assert.throws(
    () =>
      validateAuthenticatedRouteEvidence('/admin/prospects/outreach', [
        { id: 'outreach-center-heading', visible: true },
        { id: 'outreach-readiness', visible: false },
      ]),
    /route-evidence-missing/u,
  )
  assert.throws(
    () =>
      validateAuthenticatedRouteEvidence('/admin/operations', [
        { id: 'founder-control-room-heading', visible: true },
        { id: 'wrong-marker', visible: true },
      ]),
    /route-evidence-missing/u,
  )
  assert.doesNotThrow(() =>
    validateAuthenticatedRouteEvidence('/admin/reviewed-custom-surface', [
      { id: 'main-landmark', visible: true },
    ]),
  )
})

test('rejects a redirected or unauthenticated destination before pixel capture', () => {
  const origin = 'https://dashboard.example.test'
  assert.doesNotThrow(() =>
    validateAuthenticatedSurfaceDestination(
      origin,
      '/admin/operations',
      origin,
      '/admin/operations',
    ),
  )
  assert.throws(
    () =>
      validateAuthenticatedSurfaceDestination(
        origin,
        '/admin/operations',
        'https://identity.example.test',
        '/sign-in',
      ),
    /cross-origin-redirect/u,
  )
  assert.throws(
    () => validateAuthenticatedSurfaceDestination(origin, '/admin/operations', origin, '/sign-in'),
    /session-unavailable/u,
  )
  assert.throws(
    () => validateAuthenticatedSurfaceDestination(origin, '/admin/operations', origin, '/admin'),
    /route-mismatch/u,
  )
})
