import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const schemaPath = path.join(repositoryRoot, 'packages/db/prisma/schema.prisma')
const registryPath = path.join(repositoryRoot, 'packages/db/src/tenanted-tables.ts')
const registryNames = ['TENANTED_TABLES', 'PLATFORM_TABLES', 'SHARED_SCOPE_TABLES']

function parsePrismaModels(source) {
  const models = new Map()
  const modelPattern = /^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm
  const declaredModelCount = [...source.matchAll(/^\s*model\s+\w+\s*\{/gm)].length

  for (const match of source.matchAll(modelPattern)) {
    const [, name, body] = match
    const tenantField = body.match(/^\s*tenantId\s+(\S+)/m)
    models.set(name, {
      tenantScope: tenantField ? (tenantField[1].endsWith('?') ? 'optional' : 'required') : 'none',
    })
  }

  if (models.size !== declaredModelCount) {
    throw new Error(
      `Prisma model parser found ${models.size} of ${declaredModelCount} declared model blocks`,
    )
  }
  if (models.size === 0) {
    throw new Error('Prisma model parser found no model blocks')
  }

  return models
}

function unwrapExpression(expression) {
  let current = expression
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current))
  ) {
    current = current.expression
  }
  return current
}

function parseRegistries(source, fileName = 'tenanted-tables.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const registries = new Map(registryNames.map((name) => [name, []]))
  const seenRegistries = new Set()

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !registries.has(declaration.name.text)) continue
      if (seenRegistries.has(declaration.name.text)) {
        throw new Error(`${declaration.name.text} must be declared exactly once`)
      }
      seenRegistries.add(declaration.name.text)
      const initializer = unwrapExpression(declaration.initializer)
      if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
        throw new Error(`${declaration.name.text} must be a static string array`)
      }

      const values = initializer.elements.map((element) => {
        if (!ts.isStringLiteral(element) && !ts.isNoSubstitutionTemplateLiteral(element)) {
          throw new Error(`${declaration.name.text} may contain only string literals`)
        }
        return element.text
      })
      registries.set(declaration.name.text, values)
    }
  }

  for (const registryName of registryNames) {
    if (!seenRegistries.has(registryName)) {
      throw new Error(`${registryName} registry declaration is missing`)
    }
  }

  return registries
}

function auditRegistry(schemaSource, registrySource) {
  const models = parsePrismaModels(schemaSource)
  const registries = parseRegistries(registrySource)
  const violations = []
  const classifications = new Map()

  for (const registryName of registryNames) {
    for (const modelName of registries.get(registryName) ?? []) {
      if (!models.has(modelName)) {
        violations.push(`${registryName}: stale model '${modelName}' is absent from schema.prisma`)
      }
      const existing = classifications.get(modelName) ?? []
      existing.push(registryName)
      classifications.set(modelName, existing)
    }
  }

  for (const [modelName, model] of models) {
    const modelClassifications = classifications.get(modelName) ?? []
    if (modelClassifications.length === 0) {
      violations.push(`${modelName}: Prisma model is not classified in any isolation registry`)
    } else if (modelClassifications.length > 1) {
      violations.push(
        `${modelName}: Prisma model appears in multiple isolation registries (${modelClassifications.join(', ')})`,
      )
    }

    const isTenanted = modelClassifications.includes('TENANTED_TABLES')
    const isSharedScope = modelClassifications.includes('SHARED_SCOPE_TABLES')
    const isPlatform = modelClassifications.includes('PLATFORM_TABLES')
    if (model.tenantScope === 'required' && !isTenanted) {
      violations.push(`${modelName}: required tenantId model must be in TENANTED_TABLES`)
    }
    if (isTenanted && model.tenantScope !== 'required') {
      violations.push(`${modelName}: TENANTED_TABLES model must declare a required tenantId field`)
    }
    if (isSharedScope && model.tenantScope !== 'optional') {
      violations.push(
        `${modelName}: SHARED_SCOPE_TABLES model must declare an optional tenantId field`,
      )
    }
    if (model.tenantScope === 'optional' && !isSharedScope) {
      violations.push(`${modelName}: optional tenantId model must be in SHARED_SCOPE_TABLES`)
    }
    if (isPlatform && model.tenantScope !== 'none') {
      violations.push(`${modelName}: PLATFORM_TABLES model must not declare tenantId`)
    }
    if (model.tenantScope === 'none' && !isPlatform) {
      violations.push(`${modelName}: model without tenantId must be in PLATFORM_TABLES`)
    }
  }

  return { models, registries, violations }
}

function runSelfTests() {
  const schema = `
model Scoped {
  id String @id
  tenantId String
}
  model Platform {
    id String @id
  }
model Shared {
  id String @id
  tenantId String?
}
`
  const cleanRegistry = `
export const TENANTED_TABLES = ['Scoped'] as const
export const PLATFORM_TABLES = ['Platform'] as const
export const SHARED_SCOPE_TABLES = ['Shared'] as const
`
  if (auditRegistry(schema, cleanRegistry).violations.length !== 0) {
    throw new Error('Tenant registry verifier failed its clean-fixture self-test')
  }

  for (const [label, invalidSchema] of [
    ['empty', 'enum OnlyEnum { VALUE }'],
    ['duplicate', `${schema}\n${schema}`],
  ]) {
    try {
      parsePrismaModels(invalidSchema)
      throw new Error(`Tenant registry verifier accepted its ${label}-schema self-test fixture`)
    } catch (error) {
      if (error.message.includes('accepted its')) throw error
    }
  }

  const brokenRegistry = cleanRegistry.replace("['Scoped']", '[]')
  const brokenViolations = auditRegistry(schema, brokenRegistry).violations
  if (
    !brokenViolations.some((violation) => violation.includes('not classified')) ||
    !brokenViolations.some((violation) => violation.includes('required tenantId'))
  ) {
    throw new Error('Tenant registry verifier failed its missing-tenanted-model self-test')
  }

  const staleRegistry = cleanRegistry.replace("['Platform']", "['Platform', 'Removed']")
  if (
    !auditRegistry(schema, staleRegistry).violations.some((violation) =>
      violation.includes('stale'),
    )
  ) {
    throw new Error('Tenant registry verifier failed its stale-entry self-test')
  }

  const duplicateRegistry = cleanRegistry.replace("['Platform']", "['Platform', 'Scoped']")
  if (
    !auditRegistry(schema, duplicateRegistry).violations.some((violation) =>
      violation.includes('multiple isolation registries'),
    )
  ) {
    throw new Error('Tenant registry verifier failed its duplicate-classification self-test')
  }

  const unsafeOptionalRegistry = cleanRegistry
    .replace("['Platform']", "['Platform', 'Shared']")
    .replace("['Shared']", '[]')
  if (
    !auditRegistry(schema, unsafeOptionalRegistry).violations.some((violation) =>
      violation.includes('optional tenantId'),
    )
  ) {
    throw new Error('Tenant registry verifier failed its optional-tenant placement self-test')
  }
}

runSelfTests()

const [schemaSource, registrySource] = await Promise.all([
  readFile(schemaPath, 'utf8'),
  readFile(registryPath, 'utf8'),
])
const { models, registries, violations } = auditRegistry(schemaSource, registrySource)

if (violations.length > 0) {
  console.error('Tenant isolation registry violations:')
  for (const violation of violations.sort()) console.error(`- ${violation}`)
  process.exit(1)
}

console.log(
  `Verified ${models.size} Prisma models: ` +
    `${registries.get('TENANTED_TABLES').length} tenanted, ` +
    `${registries.get('PLATFORM_TABLES').length} platform, and ` +
    `${registries.get('SHARED_SCOPE_TABLES').length} shared-scope.`,
)
