import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const dashboardRoot = join(repoRoot, 'apps/dashboard')
const adminRoutesRoot = join(dashboardRoot, 'app/(admin)/admin')
// GitHub's push checkout is shallow, so the R2 commit object may be absent.
// Tree IDs still prove these four directories have the exact reviewed R2 content.
const reviewedR2ProtectedTrees = {
  'packages/api': '755c440dad6c34efcf75dc0701409009dbbab740',
  'packages/db': '07f11ba22143bb20c33ef0e1116bb3751eaa4fd8',
  'apps/workers': '9613390ac79466bc72424208b0a8e9dc1e0033cd',
  scripts: 'c4e8619f276654842830fd818d11a4ee7bbe7a70',
} as const

const reviewedAdminRoutes = [
  '/admin',
  '/admin/ai',
  '/admin/billing',
  '/admin/character-lab',
  '/admin/clients/[tenantId]',
  '/admin/clients/[tenantId]/analytics',
  '/admin/clients/[tenantId]/billing',
  '/admin/clients/[tenantId]/credentials',
  '/admin/clients/[tenantId]/offboarding',
  '/admin/clients/[tenantId]/venues/[venueId]',
  '/admin/clients/[tenantId]/venues/[venueId]/agents',
  '/admin/clients/[tenantId]/venues/[venueId]/agents/integrations',
  '/admin/clients/[tenantId]/venues/[venueId]/agents/routines',
  '/admin/clients/[tenantId]/venues/[venueId]/agents/runs/[runId]',
  '/admin/clients/[tenantId]/venues/[venueId]/agents/settings',
  '/admin/clients/[tenantId]/venues/[venueId]/ai-configuration',
  '/admin/clients/[tenantId]/venues/[venueId]/analysis',
  '/admin/clients/[tenantId]/venues/[venueId]/analysis/[snapshotId]',
  '/admin/clients/[tenantId]/venues/[venueId]/chatlogs',
  '/admin/clients/[tenantId]/venues/[venueId]/chatlogs/[sessionId]',
  '/admin/clients/[tenantId]/venues/[venueId]/compatibility-content',
  '/admin/clients/[tenantId]/venues/[venueId]/content',
  '/admin/clients/[tenantId]/venues/[venueId]/deployment-manifest',
  '/admin/clients/[tenantId]/venues/[venueId]/evaluations',
  '/admin/clients/[tenantId]/venues/[venueId]/feature-access',
  '/admin/clients/[tenantId]/venues/[venueId]/freshness',
  '/admin/clients/[tenantId]/venues/[venueId]/guest-design',
  '/admin/clients/[tenantId]/venues/[venueId]/intake',
  '/admin/clients/[tenantId]/venues/[venueId]/knowledge-proposals',
  '/admin/clients/[tenantId]/venues/[venueId]/locations',
  '/admin/clients/[tenantId]/venues/[venueId]/media',
  '/admin/clients/[tenantId]/venues/[venueId]/media/[projectId]',
  '/admin/clients/[tenantId]/venues/[venueId]/native-releases',
  '/admin/clients/[tenantId]/venues/[venueId]/packages',
  '/admin/clients/[tenantId]/venues/[venueId]/qr-kit',
  '/admin/clients/[tenantId]/venues/[venueId]/reports',
  '/admin/clients/[tenantId]/venues/[venueId]/reports/[reportId]',
  '/admin/clients/[tenantId]/venues/[venueId]/support-operations',
  '/admin/clients/[tenantId]/venues/[venueId]/visitor-access',
  '/admin/company-brain',
  '/admin/directory',
  '/admin/help',
  '/admin/new',
  '/admin/operations',
  '/admin/prospects',
  '/admin/prospects/[prospectId]',
  '/admin/prospects/duplicates',
  '/admin/prospects/imports',
  '/admin/prospects/inbound',
  '/admin/prospects/new',
  '/admin/prospects/outreach',
  '/admin/prospects/outreach/[campaignId]',
  '/admin/prospects/pipeline',
  '/admin/prospects/review-proposals',
].sort()

function filesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const absolutePath = join(directory, name)
    return statSync(absolutePath).isDirectory() ? filesBelow(absolutePath) : [absolutePath]
  })
}

function appSourceFiles(): string[] {
  return [join(dashboardRoot, 'app'), join(dashboardRoot, 'components')]
    .flatMap(filesBelow)
    .filter((file) => /\.[jt]sx?$/.test(file))
}

function quotedValues(source: string, attribute: string): string[] {
  const pattern = new RegExp(
    '\\b' + attribute + '\\s*=\\s*\\{?\\s*(["\\x27\\x60])([^"\\x27\\x60]*?)\\1',
    'g',
  )
  return [...source.matchAll(pattern)]
    .map((match) => match[2])
    .filter((value): value is string => value !== undefined)
}

describe('Packet 11 admin contracts', () => {
  it('retains the exact 54 admin page routes from published R2', () => {
    const actualRoutes = filesBelow(adminRoutesRoot)
      .filter((file) => file.endsWith(`${join('page.tsx')}`))
      .map((file) => {
        const appRelative = relative(join(dashboardRoot, 'app/(admin)'), file)
        return `/${appRelative.replace(/\\/g, '/').replace(/\/page\.tsx$/, '')}`
      })
      .sort()

    expect(reviewedAdminRoutes).toHaveLength(54)
    expect(actualRoutes).toEqual(reviewedAdminRoutes)
  })

  it('keeps every statically linked admin fragment backed by an element id', () => {
    const sourceFiles = appSourceFiles()
    const ids = new Set(
      sourceFiles.flatMap((file) => quotedValues(readFileSync(file, 'utf8'), 'id')),
    )
    const fragments = sourceFiles.flatMap((file) =>
      quotedValues(readFileSync(file, 'utf8'), 'href')
        .filter((href) => href.startsWith('/admin') && href.includes('#'))
        .map((href) => ({
          file: relative(repoRoot, file),
          href,
          id: href.split('#').at(-1) ?? '',
        })),
    )

    expect(fragments.length).toBeGreaterThan(0)
    expect(fragments.filter(({ id }) => !ids.has(id))).toEqual([])
  })

  it('does not change agent backend, worker, or script files from R2', () => {
    for (const [path, expectedTree] of Object.entries(reviewedR2ProtectedTrees)) {
      const actualTree = execFileSync('git', ['rev-parse', `HEAD:${path}`], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim()
      expect(actualTree, `${path} differs from reviewed R2`).toBe(expectedTree)
    }
    const changedProtectedFiles = execFileSync(
      'git',
      ['diff', '--name-only', 'HEAD', '--', ...Object.keys(reviewedR2ProtectedTrees)],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim()
    expect(changedProtectedFiles).toBe('')
  })

  it('exposes the five top-level destinations, four System tabs, and five venue groups', () => {
    const sectionShell = readFileSync(
      join(dashboardRoot, 'components/admin/AdminSectionShell.tsx'),
      'utf8',
    )
    const workspaceShell = readFileSync(
      join(dashboardRoot, 'components/admin/ClientWorkspaceShell.tsx'),
      'utf8',
    )
    const topNavBlock =
      sectionShell.match(/const navigationItems = \[([\s\S]*?)\] as const/)?.[1] ?? ''
    const systemTabsBlock =
      sectionShell.match(/const systemTabs = \[([\s\S]*?)\] as const/)?.[1] ?? ''
    const topNavLabels = [...topNavBlock.matchAll(/label:\s*'([^']+)'/g)].map((match) => match[1])
    const systemTabLabels = [...systemTabsBlock.matchAll(/label:\s*'([^']+)'/g)].map(
      (match) => match[1],
    )

    expect(topNavLabels).toEqual(['Needs you', 'Clients', 'Prospects', 'Company Brain', 'System'])
    expect(systemTabLabels).toEqual(['Operations', 'AI', 'Billing', 'Help'])
    expect(workspaceShell).toContain('label="Overview"')
    expect(workspaceShell).toContain('label="Content"')
    expect(workspaceShell).toContain('label="Visitor experience"')
    expect(workspaceShell).toContain('label="Conversations & quality"')
    expect(workspaceShell).toContain('label="Operations"')
    expect(workspaceShell).toContain('href: `${venueRoot}/visitor-access`')
  })
})
