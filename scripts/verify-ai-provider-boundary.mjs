import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const ignoredDirectories = new Set(['.git', '.next', '.turbo', 'dist', 'node_modules'])
const providers = ['@anthropic-ai/sdk', 'openai']

// Temporary, explicit exceptions. Delete each entry when that processor moves
// behind @pathfinder/ai; adding an exception requires code review in this file.
const sourceImportAllowlist = new Map([
  ['packages/ai/src/anthropic.test.ts', new Set(['@anthropic-ai/sdk'])],
  ['packages/ai/src/anthropic.ts', new Set(['@anthropic-ai/sdk'])],
  ['packages/ai/src/openai-embeddings.test.ts', new Set(['openai'])],
  ['packages/ai/src/openai-embeddings.ts', new Set(['openai'])],
  ['packages/ai/src/openai-media.ts', new Set(['openai'])],
  ['packages/ai/src/openai-text.ts', new Set(['openai'])],
])
const dependencyAllowlist = new Map([['packages/ai/package.json', new Set(providers)]])

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectFiles(absolute)))
    else files.push(absolute)
  }
  return files
}

function relativePath(absolute) {
  return path.relative(repositoryRoot, absolute).split(path.sep).join('/')
}

function providerFromSpecifier(node) {
  if (!node || (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node))) {
    return null
  }
  return providers.find(
    (provider) => node.text === provider || node.text.startsWith(`${provider}/`),
  )
}

function providerImports(source, fileName = 'fixture.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const imports = []
  const visit = (node) => {
    let provider = null
    let kind = null
    if (ts.isImportDeclaration(node)) {
      provider = providerFromSpecifier(node.moduleSpecifier)
      kind = node.importClause?.isTypeOnly ? 'type-only import' : 'import'
    } else if (ts.isExportDeclaration(node)) {
      provider = providerFromSpecifier(node.moduleSpecifier)
      kind = 'export-from'
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      provider = providerFromSpecifier(node.moduleReference.expression)
      kind = 'import-equals'
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if (isDynamicImport || isRequire) {
        provider = providerFromSpecifier(node.arguments[0])
        kind = isDynamicImport ? 'dynamic import' : 'require'
      }
    }
    if (provider && kind) imports.push({ provider, kind })
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return imports
}

for (const [kind, fixture, provider] of [
  ['static', "import OpenAI from '" + "openai'", 'openai'],
  ['type-only', "import type Anthropic from '" + "@anthropic-ai/sdk'", '@anthropic-ai/sdk'],
  ['side-effect', "import '" + "openai'", 'openai'],
  ['export-from', "export { OpenAI } from '" + "openai'", 'openai'],
  [
    'commented dynamic',
    "void import /* boundary */ ('" + "@anthropic-ai/sdk')",
    '@anthropic-ai/sdk',
  ],
  ['template dynamic', 'void import(`' + 'openai`)', 'openai'],
  ['commented require', "require /* boundary */ ('" + "openai')", 'openai'],
]) {
  if (!providerImports(fixture).some((entry) => entry.provider === provider)) {
    throw new Error(`AI provider boundary detector failed its ${kind} self-test`)
  }
}

const roots = ['apps', 'packages', 'scripts'].map((directory) =>
  path.join(repositoryRoot, directory),
)
const files = [
  path.join(repositoryRoot, 'package.json'),
  ...(await Promise.all(roots.map(collectFiles))).flat(),
]
const violations = []
const observedSourceImports = new Set()
const observedDependencies = new Set()
let scannedSourceFiles = 0

for (const absolute of files) {
  const relative = relativePath(absolute)
  if (sourceExtensions.has(path.extname(absolute))) {
    scannedSourceFiles += 1
    const source = await readFile(absolute, 'utf8')
    for (const { provider, kind } of providerImports(source, relative)) {
      const key = `${relative}\0${provider}`
      observedSourceImports.add(key)
      if (!sourceImportAllowlist.get(relative)?.has(provider)) {
        violations.push(`${relative}: direct ${provider} SDK ${kind}`)
      }
    }
  }

  if (path.basename(absolute) === 'package.json') {
    const manifest = JSON.parse(await readFile(absolute, 'utf8'))
    const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies']
    for (const section of dependencySections) {
      for (const provider of providers) {
        if (manifest[section]?.[provider]) {
          observedDependencies.add(`${relative}\0${provider}`)
          if (!dependencyAllowlist.get(relative)?.has(provider)) {
            violations.push(`${relative}: ${provider} declared in ${section}`)
          }
        }
      }
    }
  }
}

for (const [relative, allowedProviders] of sourceImportAllowlist) {
  for (const provider of allowedProviders) {
    if (!observedSourceImports.has(`${relative}\0${provider}`)) {
      violations.push(`${relative}: stale ${provider} source allowlist entry`)
    }
  }
}

for (const [relative, allowedProviders] of dependencyAllowlist) {
  for (const provider of allowedProviders) {
    if (!observedDependencies.has(`${relative}\0${provider}`)) {
      violations.push(`${relative}: stale ${provider} dependency allowlist entry`)
    }
  }
}

if (violations.length > 0) {
  console.error('AI provider boundary violations:')
  for (const violation of violations.sort()) console.error(`- ${violation}`)
  process.exit(1)
}

console.log(
  `Verified AI provider boundary across ${scannedSourceFiles} source files; ` +
    `${[...observedSourceImports].filter((entry) => entry.startsWith('apps/workers/')).length} ` +
    'temporary worker exceptions remain.',
)
