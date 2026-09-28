import { readFileSync, readdirSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { ADMIN_AGENT_SURFACE_MAP } from './CopyForCodexMap'
import { buildCopyForCodexText, readPageContext, resolveAdminContextRoute } from './CopyForCodex'

const repoRoot = resolve(__dirname, '../../../..')
const adminPages = resolve(repoRoot, 'apps/dashboard/app/(admin)/admin')

const adminRouterSources = (() => {
  const seen = new Set<string>()
  const sources: string[] = []
  function visit(current: string) {
    if (seen.has(current)) return
    seen.add(current)
    const source = readFileSync(current, 'utf8')
    sources.push(source)
    for (const [, relative] of source.matchAll(/import\s+\{[^}]+\}\s+from\s+'(\.\/[^']+)'/gu)) {
      visit(resolve(current, '..', `${relative}.ts`))
    }
  }
  visit(resolve(repoRoot, 'packages/api/src/routers/admin/_admin.ts'))
  return sources
})()

const registrySources = new Map<string, string>()
function registrySource(file: string) {
  let source = registrySources.get(file)
  if (!source) {
    source = readFileSync(resolve(repoRoot, 'packages/api/src/routers/admin', file), 'utf8')
    registrySources.set(file, source)
  }
  return source
}

function pageRoutes(directory: string): { route: string; template: string }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const absolute = resolve(directory, item.name)
    if (item.isDirectory()) return pageRoutes(absolute)
    if (!item.isFile() || item.name !== 'page.tsx') return []
    const relative = absolute.slice(adminPages.length).replaceAll(sep, '/')
    const routeTail = relative.replace(/\/page\.tsx$/u, '')
    return [
      {
        template: `/admin${routeTail}`,
        route: `/admin${routeTail.replace(/\[[^/]+\]/gu, 'sample')}`,
      },
    ]
  })
}

describe('Copy for Codex context allowlist', () => {
  it('includes only explicit safe context and drops secret-like or visitor fields and values', () => {
    const entry = resolveAdminContextRoute(
      '/admin/clients/t1/venues/v1/guest-design',
      ADMIN_AGENT_SURFACE_MAP,
    )
    const text = buildCopyForCodexText(
      {
        pageName: 'Guest design',
        route: '/admin/clients/tenant_12/venues/venue_34/guest-design?token=do-not-copy#details',
        tenant: { id: 'tenant_12', name: 'Maple Hollow' },
        venue: { id: 'venue_34', name: 'Maple Hollow' },
        filters: {
          status: 'active',
          selection: 'draft-2',
          email: 'person@example.com',
          apiKey: 'secret-value',
          visitorMessage: 'Please help me find my room',
          search: 'private query',
          session: 'session_123',
        },
      },
      entry,
    )
    expect(text).toContain('Maple Hollow')
    expect(text).toContain('status=active')
    expect(text).not.toMatch(
      /person@example|secret-value|Please help|private query|session_123|token=/iu,
    )
    expect(text).toContain('admin.getGuestDesign')
  })

  it('rejects unsafe entity labels and strips query values from routes', () => {
    const text = buildCopyForCodexText(
      {
        route: '/admin/clients/tenant1/venues/venue1?email=a@example.com',
        tenant: { id: 'tenant1', name: 'owner@example.com' },
        venue: { id: 'access_token', name: 'Visitor said: help' },
      },
      undefined,
    )
    expect(text).not.toMatch(/example\.com|access_token|Visitor said|email=/iu)
    expect(text).toContain('Route: /admin/clients/tenant1/venues/venue1')
    const unsafeIdRoute = buildCopyForCodexText(
      { route: '/admin/clients/tenant1/venues/access_token/guest-design' },
      undefined,
    )
    expect(unsafeIdRoute).not.toContain('access_token')
    expect(unsafeIdRoute).toContain('/venues/[redacted]/guest-design')
  })

  it('uses only the named visible DOM attributes and allowlisted URL filters when props omit names and filters', () => {
    const previousDocument = globalThis.document
    const previousWindow = globalThis.window
    const values = {
      'data-admin-tenant-name': 'Maple Group',
      'data-admin-venue-name': 'Maple Hollow',
    }
    vi.stubGlobal('document', {
      querySelector: (selector: string) => ({
        dataset: selector.includes('tenant')
          ? { adminTenantName: values['data-admin-tenant-name'] }
          : { adminVenueName: values['data-admin-venue-name'] },
      }),
    })
    vi.stubGlobal('window', {
      location: { search: '?status=active&tab=content&search=private&email=a%40b.com' },
    })
    try {
      const context = readPageContext({
        route: '/admin/clients/t1/venues/v1',
        tenant: { id: 't1', name: '' },
        venue: { id: 'v1', name: '' },
      })
      const text = buildCopyForCodexText(context, undefined)
      expect(text).toContain('Maple Group')
      expect(text).toContain('Maple Hollow')
      expect(text).toContain('status=active, tab=content')
      expect(text).not.toMatch(/private|a@b\.com|email=/u)
    } finally {
      vi.stubGlobal('document', previousDocument)
      vi.stubGlobal('window', previousWindow)
    }
  })

  it('maps every current admin page route to a reviewed entry', () => {
    const pages = pageRoutes(adminPages)
    expect(pages).toHaveLength(54)
    expect(ADMIN_AGENT_SURFACE_MAP).toHaveLength(54)
    expect(ADMIN_AGENT_SURFACE_MAP.map((entry) => entry.routeTemplate).sort()).toEqual(
      pages.map((page) => page.template).sort(),
    )
    for (const { route } of pages) {
      expect(
        resolveAdminContextRoute(route, ADMIN_AGENT_SURFACE_MAP),
        `missing map for ${route}`,
      ).toBeDefined()
    }
  })

  it('keeps route mappings narrow to the procedures actually used by that page', () => {
    const proceduresFor = (route: string) =>
      resolveAdminContextRoute(route, ADMIN_AGENT_SURFACE_MAP)?.procedures
    expect(proceduresFor('/admin/clients/acme/venues/maple/content')).toEqual([
      'admin.listUniversalContent',
    ])
    expect(proceduresFor('/admin/clients/acme/analytics')).toEqual(['admin.getClientAnalytics'])
    expect(proceduresFor('/admin/prospects/sample')).toEqual([
      'admin.getProspect',
      'admin.getProspectIntelligence',
    ])
    expect(proceduresFor('/admin/prospects/pipeline')).toEqual(['admin.getProspectPipeline'])
    expect(proceduresFor('/admin/prospects')).toEqual([
      'admin.listProspectTerritories',
      'admin.listProspectSavedViews',
      'admin.listProspects',
    ])
    expect(proceduresFor('/admin/clients/acme/venues/maple/analysis/snap1')).toEqual([
      'admin.getAnswerAnalysis',
    ])
    expect(proceduresFor('/admin/clients/acme/venues/maple/visitor-access')).toEqual([
      'admin.venueDistribution.get',
    ])
  })

  it('matches mapped callable procedure paths to the admin router structure', () => {
    const mcpRegistry = readFileSync(
      resolve(repoRoot, 'packages/api/src/mcp/composition.ts'),
      'utf8',
    )
    for (const entry of ADMIN_AGENT_SURFACE_MAP) {
      for (const tool of entry.mcp) expect(mcpRegistry).toContain(`'${tool}'`)
      for (const procedure of entry.procedures) {
        expect(procedure.startsWith('admin.'), `not a callable admin path: ${procedure}`).toBe(true)
        const parts = procedure.split('.')
        const key = parts.at(-1)!
        const matchingFiles = entry.registryFiles.filter((file) => {
          const source = registrySource(file)
          return source.includes(`${key}: adminProcedure`)
        })
        expect(matchingFiles.length, `missing registry procedure ${procedure}`).toBeGreaterThan(0)
        for (const file of matchingFiles) {
          const source = registrySource(file)
          const exportName = source.match(/export const (\w+) = router\(/u)?.[1]
          if (!exportName) continue
          expect(
            adminRouterSources.some((source) => source.includes(exportName)),
            `router for ${procedure} is not merged into adminRouter`,
          ).toBe(true)
        }
        if (parts.length > 2) {
          const namespace = parts[1]
          expect(procedure).toBe('admin.venueDistribution.get')
          expect(
            entry.registryFiles.some((file) => {
              const source = registrySource(file)
              return (
                source.includes(`${namespace}: venueDistributionProcedures`) ||
                source.includes(`${namespace}:`)
              )
            }),
            `missing callable namespace in ${procedure}`,
          ).toBe(true)
        }
      }
    }
  })
})
