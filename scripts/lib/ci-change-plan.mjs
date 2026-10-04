// Dependency-aware change classifier for development CI runs.
//
// Pure functions only: callers inject the change list and a read-only repository view so the
// whole decision matrix is testable without a git checkout. Every uncertainty resolves to the
// FULL plan; the only way to skip a job is a positive proof that the change cannot reach it.
//
// Selective success is never release approval: protected refs, release branches, merge queues
// and manual dispatches are forced to FULL by `forcedFullReason`, and the workflow repeats that
// rule in YAML so it does not depend on this file being unmodified.

import path from 'node:path'

export const PLAN_VERSION = 1

// Workspaces whose behavior needs the disposable PostgreSQL/Redis/S3 integration block.
export const DATABASE_SENSITIVE = [
  'packages/db',
  'packages/api',
  'packages/jobs',
  'packages/billing',
  'packages/ai',
  'packages/analytics',
  'packages/auth',
  'packages/contracts',
  'packages/config',
  'packages/intake-engine',
  'apps/workers',
]

// Workspaces that own a browser surface (visual smoke, bundle secret scan, visitor launch).
export const BROWSER_SURFACES = ['apps/dashboard', 'apps/web']

// Shared tooling bases (eslint, tsconfig, logger, env): a change reaches every workspace.
export const FULL_FANOUT_WORKSPACES = ['packages/config']

export const PROTECTED_BRANCHES = ['master', 'codex/pathfinder-v2-staging']
export const SELECTIVE_EVENTS = ['pull_request', 'push']
export const MAX_CHANGED_FILES = 1500

const FULL_EXACT = new Set([
  'CLAUDE.md',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  'turbo.json',
  '.npmrc',
  '.nvmrc',
  '.node-version',
  '.gitignore',
  '.gitattributes',
  '.dockerignore',
  '.prettierrc',
  '.env.example',
  'vitest.config.ts',
  'nixpacks.toml',
])
const FULL_PATTERNS = [
  /^Dockerfile[^/]*$/u,
  /^railway[^/]*\.json$/u,
  /^compose[^/]*\.ya?ml$/u,
  /^tsconfig[^/]*\.json$/u,
]
const FULL_PREFIXES = [
  '.github/',
  '.husky/',
  '.railway/',
  'scripts/',
  'tools/',
  'assets/',
  'packages/db/prisma/',
  'packages/auth/',
]
const DOC_ROOT_DIRECTORIES = ['docs/', 'qa/', 'memory/']
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.png', '.jpg', '.jpeg', '.gif', '.json'])
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'])
const TEXT_CONSUMER_EXTENSIONS = new Set([
  ...SOURCE_EXTENSIONS,
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.sh',
  '.ps1',
  '.prisma',
  '.sql',
  '.css',
  '.html',
  '.cjs',
])

export class UnsafeClassification extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'UnsafeClassification'
    this.reason = reason
  }
}

export function forcedFullReason({ event, ref, headRef, baseRef } = {}) {
  if (!SELECTIVE_EVENTS.includes(event)) {
    return `event "${event ?? 'unknown'}" always runs the full suite`
  }
  const branch = typeof ref === 'string' ? ref.replace(/^refs\/heads\//u, '') : ''
  if (event === 'push' && PROTECTED_BRANCHES.includes(branch)) {
    return `push to protected branch "${branch}" always runs the full suite`
  }
  if (event === 'pull_request') {
    if (PROTECTED_BRANCHES.includes(headRef ?? '')) {
      return `pull request from release branch "${headRef}" always runs the full suite`
    }
    if (baseRef && baseRef !== 'master') {
      return `pull request base "${baseRef}" is not master; full suite`
    }
  }
  return null
}

// `git diff --name-status -M -z` => [{ status, paths: [...] }]. Throws on anything unexpected.
export function parseNameStatusZ(output) {
  if (typeof output !== 'string') throw new UnsafeClassification('diff output missing')
  if (output.length === 0) return []
  if (!output.endsWith('\0')) throw new UnsafeClassification('diff output truncated')
  const tokens = output.slice(0, -1).split('\0')
  const entries = []
  let index = 0
  while (index < tokens.length) {
    const status = tokens[index++]
    if (!/^[ACDMRT]\d{0,3}$/u.test(status ?? '')) {
      throw new UnsafeClassification(`unsupported diff status "${status}"`)
    }
    const needed = status[0] === 'R' || status[0] === 'C' ? 2 : 1
    const paths = tokens.slice(index, index + needed)
    index += needed
    if (paths.length !== needed || paths.some((value) => !value)) {
      throw new UnsafeClassification('diff record incomplete')
    }
    for (const value of paths) {
      if (
        value.startsWith('/') ||
        value.includes('\\') ||
        value.split('/').some((part) => part === '..' || part === '')
      ) {
        throw new UnsafeClassification(`unsafe changed path "${value}"`)
      }
    }
    entries.push({ status, paths })
  }
  return entries
}

function parseWorkspacePatterns(source) {
  if (typeof source !== 'string') throw new UnsafeClassification('pnpm-workspace.yaml missing')
  const patterns = [...source.matchAll(/^\s*-\s+['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/gmu)].map(
    (match) => match[1],
  )
  if (patterns.length === 0) throw new UnsafeClassification('no workspace patterns found')
  for (const pattern of patterns) {
    if (!/^[A-Za-z0-9_.-]+(?:\/(?:\*|[A-Za-z0-9_.-]+))?$/u.test(pattern)) {
      throw new UnsafeClassification(`unsupported workspace pattern "${pattern}"`)
    }
  }
  return patterns
}

export function discoverWorkspaces(repo) {
  const patterns = parseWorkspacePatterns(repo.read('pnpm-workspace.yaml'))
  const manifests = repo.files.filter((file) => file.endsWith('/package.json'))
  const directories = new Set()
  for (const manifest of manifests) {
    const dir = path.posix.dirname(manifest)
    for (const pattern of patterns) {
      const wildcard = pattern.endsWith('/*')
      if (wildcard ? path.posix.dirname(dir) === pattern.slice(0, -2) : dir === pattern) {
        directories.add(dir)
      }
    }
  }
  const workspaces = []
  for (const dir of [...directories].sort()) {
    let manifest
    try {
      manifest = JSON.parse(repo.read(`${dir}/package.json`))
    } catch {
      throw new UnsafeClassification(`unreadable manifest ${dir}/package.json`)
    }
    if (typeof manifest.name !== 'string') throw new UnsafeClassification(`unnamed ${dir}`)
    workspaces.push({ dir, name: manifest.name, manifest })
  }
  if (workspaces.length === 0) throw new UnsafeClassification('no workspaces discovered')
  return workspaces
}

export function ownerOf(file, workspaces) {
  let best = null
  for (const workspace of workspaces) {
    if (file === workspace.dir || file.startsWith(`${workspace.dir}/`)) {
      if (!best || workspace.dir.length > best.dir.length) best = workspace
    }
  }
  return best
}

const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"\n]+)['"]/gu

// Edges: package.json dependency fields UNION static import specifiers (bare workspace names and
// relative paths leaving the workspace). Either source alone could miss a real coupling.
export function buildDependencyGraph(workspaces, repo) {
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]))
  const dependents = new Map(workspaces.map((workspace) => [workspace.dir, new Set()]))
  const addEdge = (consumer, provider) => {
    if (consumer.dir !== provider.dir) dependents.get(provider.dir).add(consumer.dir)
  }
  for (const workspace of workspaces) {
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const name of Object.keys(workspace.manifest[field] ?? {})) {
        if (byName.has(name)) addEdge(workspace, byName.get(name))
      }
    }
  }
  for (const file of repo.files) {
    if (!SOURCE_EXTENSIONS.has(path.posix.extname(file))) continue
    const consumer = ownerOf(file, workspaces)
    if (!consumer) continue
    const source = repo.read(file)
    if (source === null) continue
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1]
      if (specifier.startsWith('.')) {
        const target = ownerOf(path.posix.join(path.posix.dirname(file), specifier), workspaces)
        if (target) addEdge(consumer, target)
      } else {
        const name = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0]
        if (byName.has(name)) addEdge(consumer, byName.get(name))
      }
    }
  }
  return dependents
}

export function transitiveConsumers(seedDirs, dependents) {
  const seen = new Set(seedDirs)
  const queue = [...seedDirs]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const next of dependents.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return seen
}

function isPolicyFull(file) {
  return (
    FULL_EXACT.has(file) ||
    FULL_PATTERNS.some((pattern) => pattern.test(file)) ||
    FULL_PREFIXES.some((prefix) => file.startsWith(prefix))
  )
}

function isDocCandidate(file) {
  const extension = path.posix.extname(file).toLowerCase()
  if (file === 'CLAUDE.md') return false
  if (DOC_ROOT_DIRECTORIES.some((prefix) => file.startsWith(prefix))) {
    return DOC_EXTENSIONS.has(extension)
  }
  return !file.includes('/') && (extension === '.md' || extension === '.mdx')
}

export function classifyPath(file, workspaces) {
  if (isPolicyFull(file)) return { kind: 'full', reason: `policy-controlled path ${file}` }
  const workspace = ownerOf(file, workspaces)
  if (workspace) {
    if (path.posix.basename(file) === 'package.json' && file === `${workspace.dir}/package.json`) {
      return { kind: 'full', reason: `${file} can change the workspace dependency graph` }
    }
    return { kind: 'workspace', workspace }
  }
  if (isDocCandidate(file)) return { kind: 'docs' }
  const prefixed = DOC_ROOT_DIRECTORIES.find((prefix) => file.startsWith(prefix))
  if (prefixed) return { kind: 'full', reason: `unrecognised file type under ${prefixed}: ${file}` }
  return { kind: 'full', reason: `unrecognised path ${file}` }
}

function tokensForDoc(doc) {
  const tokens = new Set([doc])
  const base = path.posix.basename(doc)
  // README.md / index.md style names are too generic to use as consumer evidence on their own.
  if (!/^(readme|index|changelog)\./iu.test(base)) tokens.add(base)
  const parts = doc.split('/')
  for (let depth = 2; depth < parts.length; depth += 1) {
    tokens.add(`${parts.slice(0, depth).join('/')}/`)
  }
  return [...tokens]
}

const DIRECTORY_LITERAL = /['"`]docs['"`]/u

// A doc is "consumed" when non-doc source mentions its path or basename, a nested docs directory
// prefix, or joins a bare 'docs' path segment (directory-level reads). Evidence in a workspace
// puts that workspace (and its dependents) in scope; evidence under scripts/ is covered by the
// always-run script tests; evidence anywhere else (root/infra/tooling) forces FULL.
export function findDocConsumers(docs, repo, workspaces) {
  const consumers = { workspaces: new Map(), scripts: new Set(), unscoped: new Set() }
  if (docs.length === 0) return consumers
  const docSet = new Set(docs)
  const tokenTable = docs.map((doc) => ({ doc, tokens: tokensForDoc(doc) }))
  for (const file of repo.files) {
    if (docSet.has(file) || isDocCandidate(file)) continue
    const extension = path.posix.extname(file).toLowerCase()
    // Extensionless files (Dockerfile, hooks) are scanned too: they are exactly where a docs COPY hides.
    if (extension !== '' && !TEXT_CONSUMER_EXTENSIONS.has(extension)) continue
    const source = repo.read(file)
    if (source === null) continue
    const directory = DIRECTORY_LITERAL.test(source)
    const hit =
      directory || tokenTable.some(({ tokens }) => tokens.some((token) => source.includes(token)))
    if (!hit) continue
    const workspace = ownerOf(file, workspaces)
    if (file.startsWith('scripts/')) consumers.scripts.add(file)
    else if (workspace) {
      if (!consumers.workspaces.has(workspace.dir)) consumers.workspaces.set(workspace.dir, [])
      consumers.workspaces.get(workspace.dir).push(file)
    } else consumers.unscoped.add(file)
  }
  return consumers
}

export function fullPlan(reasons, extra = {}) {
  const list = Array.isArray(reasons) ? reasons : [reasons]
  return {
    version: PLAN_VERSION,
    mode: 'full',
    reasons: list,
    changed_files: extra.changedFiles ?? null,
    affected_workspaces: [],
    docs: { changed: [], consumers: {} },
    jobs: {
      ci: true,
      railway_iac: true,
      visitor_launch: true,
      database_integration: true,
      browser_gates: true,
      workspace_graph: true,
    },
    turbo_filters: [],
  }
}

function scopedPlan({ mode, reasons, workspaces, affectedDirs, docs, consumers, changedFiles }) {
  const dirs = [...affectedDirs].sort()
  const affected = dirs.map((dir) => workspaces.find((workspace) => workspace.dir === dir))
  const hasAny = affected.length > 0
  return {
    version: PLAN_VERSION,
    mode,
    reasons,
    changed_files: changedFiles,
    affected_workspaces: affected.map(({ dir, name }) => ({ dir, name })),
    docs: {
      changed: docs,
      consumers: {
        workspaces: Object.fromEntries(
          [...consumers.workspaces].map(([dir, files]) => [dir, [...files].sort()]),
        ),
        scripts: [...consumers.scripts].sort(),
      },
    },
    jobs: {
      ci: true,
      railway_iac: true,
      visitor_launch: dirs.some((dir) => BROWSER_SURFACES.includes(dir)),
      database_integration: dirs.some((dir) => DATABASE_SENSITIVE.includes(dir)),
      browser_gates: dirs.some((dir) => BROWSER_SURFACES.includes(dir)),
      workspace_graph: hasAny,
    },
    turbo_filters: affected.map(({ name }) => name),
  }
}

// repo: { files: string[], read(path) => string | null }
// entries: parsed name-status records.
export function buildPlan({ entries, repo, context = {} }) {
  const forced = forcedFullReason(context)
  if (forced) return fullPlan(forced, { changedFiles: entries?.length ?? null })
  if (!Array.isArray(entries)) return fullPlan('change list unavailable')
  if (entries.length === 0) {
    return fullPlan('empty change list is not proof of a safe change', { changedFiles: 0 })
  }
  if (entries.length > MAX_CHANGED_FILES) {
    return fullPlan(`${entries.length} changed files exceeds the selective limit`, {
      changedFiles: entries.length,
    })
  }
  const workspaces = discoverWorkspaces(repo)
  const fullReasons = []
  const directDirs = new Set()
  const docs = new Set()
  const reasons = []

  for (const entry of entries) {
    const kinds = entry.paths.map((file) => ({ file, ...classifyPath(file, workspaces) }))
    if (entry.status[0] === 'C' || entry.status[0] === 'T') {
      fullReasons.push(`${entry.status} (${entry.paths.join(' -> ')}) is ambiguous`)
      continue
    }
    if (entry.status[0] === 'R') {
      const [from, to] = kinds
      const sameScope =
        from.kind === to.kind &&
        (from.kind !== 'workspace' || from.workspace.dir === to.workspace.dir)
      if (!sameScope) {
        fullReasons.push(`rename crosses scopes: ${from.file} -> ${to.file}`)
        continue
      }
    }
    for (const item of kinds) {
      if (item.kind === 'full') fullReasons.push(item.reason)
      else if (item.kind === 'workspace') directDirs.add(item.workspace.dir)
      else if (item.kind === 'docs') docs.add(item.file)
    }
  }

  if (fullReasons.length > 0) {
    return fullPlan([...new Set(fullReasons)].slice(0, 20), { changedFiles: entries.length })
  }

  const docList = [...docs].sort()
  const consumers = findDocConsumers(docList, repo, workspaces)
  if (consumers.unscoped.size > 0) {
    return fullPlan(
      `documentation is read by non-workspace, non-script files: ${[...consumers.unscoped]
        .sort()
        .slice(0, 5)
        .join(', ')}`,
      { changedFiles: entries.length },
    )
  }

  const seedDirs = new Set(directDirs)
  for (const dir of consumers.workspaces.keys()) seedDirs.add(dir)

  let affectedDirs = new Set()
  if (seedDirs.size > 0) {
    const dependents = buildDependencyGraph(workspaces, repo)
    affectedDirs = transitiveConsumers(seedDirs, dependents)
    if ([...seedDirs].some((dir) => FULL_FANOUT_WORKSPACES.includes(dir))) {
      affectedDirs = new Set(workspaces.map((workspace) => workspace.dir))
      reasons.push('shared tooling workspace changed: every workspace is affected')
    }
  }

  const mode = affectedDirs.size === 0 ? 'docs-only' : 'scoped'
  if (directDirs.size > 0) {
    reasons.push(`direct changes in ${[...directDirs].sort().join(', ')}`)
  }
  if (consumers.workspaces.size > 0) {
    reasons.push(
      `documentation consumed at runtime or by tests in ${[...consumers.workspaces.keys()]
        .sort()
        .join(', ')}`,
    )
  }
  if (consumers.scripts.size > 0) {
    reasons.push('documentation pinned by repository script tests (always run)')
  }
  if (mode === 'docs-only') reasons.push('only documentation not consumed by any workspace changed')
  return scopedPlan({
    mode,
    reasons,
    workspaces,
    affectedDirs,
    docs: docList,
    consumers,
    changedFiles: entries.length,
  })
}

// Wraps buildPlan so that no failure mode can produce anything but FULL.
export function safePlan(input) {
  try {
    return buildPlan(input)
  } catch (error) {
    const reason =
      error instanceof UnsafeClassification
        ? error.reason
        : `classifier error: ${error instanceof Error ? error.message : 'unknown'}`
    return fullPlan(`fail-safe: ${reason}`)
  }
}

const SAFE_FILTER = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

export function planToOutputs(plan) {
  const filters = plan.turbo_filters ?? []
  if (!filters.every((name) => SAFE_FILTER.test(name))) {
    return planToOutputs(fullPlan('unsafe workspace name in filter list'))
  }
  const flag = (value) => (value === false ? 'false' : 'true')
  return {
    mode: plan.mode,
    run_visitor_launch: flag(plan.jobs.visitor_launch),
    run_database_integration: flag(plan.jobs.database_integration),
    run_browser_gates: flag(plan.jobs.browser_gates),
    run_workspace_graph: flag(plan.jobs.workspace_graph),
    turbo_filters: filters.map((name) => `--filter=${name}`).join(' '),
  }
}

export function renderExplanation(plan) {
  const lines = [`## CI change plan: ${plan.mode.toUpperCase()}`, '']
  lines.push(`Changed files: ${plan.changed_files ?? 'unknown'}`, '')
  lines.push('Reasons:')
  for (const reason of plan.reasons) lines.push(`- ${reason}`)
  lines.push('', '| Job or gate | Plan |', '| --- | --- |')
  const rows = [
    ['ci: static policy checks and repository script tests', 'required (always)'],
    ['railway-iac', 'required (always)'],
    ['ci-required gate', 'required (always)'],
    ['disposable PostgreSQL/Redis/S3 integration block', plan.jobs.database_integration],
    ['browser gates (visual smoke, bundle scan, Packet 2)', plan.jobs.browser_gates],
    ['visitor-launch job', plan.jobs.visitor_launch],
    ['typecheck, lint, workspace tests', plan.jobs.workspace_graph],
  ]
  for (const [name, value] of rows) {
    const text = typeof value === 'string' ? value : value ? 'required' : 'not required'
    lines.push(`| ${name} | ${text} |`)
  }
  if (plan.turbo_filters.length > 0 && plan.mode === 'scoped') {
    lines.push('', `Turbo scope: ${plan.turbo_filters.join(', ')}`)
  }
  if (plan.mode === 'full') {
    lines.push('', 'Every gate runs. Selective results never substitute for this run.')
  } else {
    lines.push(
      '',
      'Selective plan: this success does not count as release approval; releases rely on a full run of the exact SHA.',
    )
  }
  return `${lines.join('\n')}\n`
}
