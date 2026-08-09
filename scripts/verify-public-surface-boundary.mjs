import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  auditPublicSurfaceManifest,
  discoverHttpMethods,
  discoverPublicTrpcSurfaces,
  discoverStringArray,
  isNextRouteModuleName,
  manifestEvidencePaths,
  validateCanonicalApiPackageExports,
  validateCanonicalAppRouterExports,
  validateCanonicalProcedureBuilders,
  validateTrpcTransportBinding,
} from './lib/public-surface-inventory.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = path.join(
  repositoryRoot,
  'packages/api/src/testing/public-surface-manifest.json',
)

function relative(absolute) {
  return path.relative(repositoryRoot, absolute).replaceAll('\\', '/')
}

async function collectFiles(directory, predicate, violations = []) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      violations.push(`${relative(absolute)}: symbolic links are not allowed in scanned trees`)
    } else if (
      entry.isDirectory() &&
      !entry.name.startsWith('.') &&
      entry.name !== 'node_modules'
    ) {
      files.push(...(await collectFiles(absolute, predicate, violations)).files)
    } else if (predicate(entry.name, absolute)) files.push(absolute)
  }
  return { files, violations }
}

const apiScan = await collectFiles(
  path.join(repositoryRoot, 'packages/api/src'),
  (name) =>
    name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.integration.test.ts'),
)
const moduleSources = new Map(
  await Promise.all(
    apiScan.files.map(async (absolute) => [relative(absolute), await readFile(absolute, 'utf8')]),
  ),
)
const trpc = discoverPublicTrpcSurfaces(moduleSources, 'packages/api/src/root.ts')
const trpcBuilderViolations = validateCanonicalProcedureBuilders(
  moduleSources.get('packages/api/src/trpc.ts') ?? '',
)
const appRouterExportViolations = validateCanonicalAppRouterExports({
  rootSource: moduleSources.get('packages/api/src/root.ts') ?? '',
  indexSource: moduleSources.get('packages/api/src/index.ts') ?? '',
})
const apiPackageExportViolations = validateCanonicalApiPackageExports(
  JSON.parse(await readFile(path.join(repositoryRoot, 'packages/api/package.json'), 'utf8')),
)

const routeScan = await collectFiles(path.join(repositoryRoot, 'apps'), isNextRouteModuleName)
const httpResults = await Promise.all(
  routeScan.files.map(async (absolute) => {
    const source = relative(absolute)
    const contents = await readFile(absolute, 'utf8')
    const transportViolations =
      source.includes('/api/trpc/') || contents.includes('@trpc/server/adapters/fetch')
        ? validateTrpcTransportBinding(contents, source)
        : []
    return {
      source,
      ...discoverHttpMethods(contents, source),
      transportViolations,
    }
  }),
)
const discoveredHttp = httpResults
  .map(({ source, methods }) => ({ source, methods }))
  .sort((left, right) => left.source.localeCompare(right.source))

const middlewarePath = path.join(repositoryRoot, 'apps/dashboard/lib/middleware-access.ts')
const publicPaths = discoverStringArray(
  await readFile(middlewarePath, 'utf8'),
  'PUBLIC_ROUTES',
  relative(middlewarePath),
)
const publicApiPaths = publicPaths.values.filter((value) => value.startsWith('/api/')).sort()
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

const violations = [
  ...apiScan.violations,
  ...routeScan.violations,
  ...trpc.violations,
  ...trpcBuilderViolations,
  ...appRouterExportViolations,
  ...apiPackageExportViolations,
  ...httpResults.flatMap((result) => result.violations),
  ...httpResults.flatMap((result) => result.transportViolations),
  ...publicPaths.violations,
  ...auditPublicSurfaceManifest({
    discoveredTrpc: trpc.procedures,
    discoveredHttp,
    publicApiPaths,
    manifest,
  }),
]

const canonicalRoot = await realpath(repositoryRoot)
for (const evidencePath of manifestEvidencePaths(manifest)) {
  try {
    const absolute = path.resolve(repositoryRoot, evidencePath)
    const canonicalEvidence = await realpath(absolute)
    const relativeEvidence = path.relative(canonicalRoot, canonicalEvidence)
    if (
      relativeEvidence === '' ||
      relativeEvidence.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeEvidence) ||
      !(await stat(canonicalEvidence)).isFile()
    ) {
      throw new Error('not a repository file')
    }
  } catch {
    violations.push(`invalid or missing behavioral evidence file: ${evidencePath}`)
  }
}

if (violations.length > 0) {
  process.stderr.write('Public surface boundary violations:\n')
  for (const violation of [...new Set(violations)].sort()) {
    process.stderr.write(`- ${violation}\n`)
  }
  process.exitCode = 1
} else {
  process.stdout.write(
    `Verified ${trpc.procedures.length} public tRPC procedures, ${discoveredHttp.length} HTTP route modules, and ${publicApiPaths.length} dashboard public API path.\n`,
  )
  process.stdout.write(
    'Static inventory does not prove runtime authorization, resource ownership, signature validity, tenant isolation, or live deployment behavior.\n',
  )
}
