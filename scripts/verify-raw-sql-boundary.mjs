import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ignoredDirectories = new Set(['.git', '.next', '.turbo', 'dist', 'node_modules'])
const sourceExtensions = new Set(['.ts', '.tsx'])
const safeMethods = new Set(['$queryRaw', '$executeRaw'])
const prohibitedMethods = new Set(['$queryRawUnsafe', '$executeRawUnsafe', '$queryRawTyped'])
const rawMethods = new Set([...safeMethods, ...prohibitedMethods])
const prismaFragmentHelpers = new Set(['sql', 'raw', 'join', 'empty'])
const approvedPolicies = new Set([
  'system-probe',
  'public-venue-slug',
  'public-venue-id',
  'public-venue-session-token',
  'tenant-and-venue',
  'tenant-venue-revision-source',
  'tenant-venue-entity-lease',
  'tenant-venue-range-generation-lease',
  'tenant-venue-range-generation-dispatch-consume',
  'platform-generation-dispatch-lease',
  'tenant-venue-record-generation-dispatch-lease',
  'platform-expired-generation-discovery',
  'platform-dispatch-lease',
  'tenant-venue-revision-lease',
  'tenant-optional-venue-cursor-audit',
  'tenant-venue-revision-canary-insert',
  'tenant-venue-exact-invariant-repair',
  'transaction-content-history-context',
  'tenant-content-history-entity-lock',
])

// Hashes bind exact SQL template and interpolation text; only CRLF/LF differences are normalized.
// Run with --print-inventory after a reviewed query change, then update only the intended entry.
const approvedOperations = [
  {
    file: 'packages/db/src/helpers/content-version-context.ts',
    method: '$executeRaw',
    hash: '847fa7ac679ecfb036d7bf675f4eb6da381e3f183487b3601d402f68b690ec45',
    policy: 'transaction-content-history-context',
  },
  {
    file: 'packages/db/src/helpers/content-version-context.ts',
    method: '$executeRaw',
    hash: 'f28fd9aa5617bff72b76ee6b4a651e3a5c486a8a44a96500361d71c103fd3fd3',
    policy: 'transaction-content-history-context',
  },
  {
    file: 'packages/db/src/helpers/content-version-context.ts',
    method: '$executeRaw',
    hash: 'daa2dc53e993865ebc671cc1dee04d1085ea1fbf70f976b84a024176f5e4b785',
    policy: 'tenant-content-history-entity-lock',
  },
  {
    file: 'packages/db/src/helpers/content-version-context.ts',
    method: '$queryRaw',
    hash: '2679d81ae1880a220185b63a111b458048e20db8c2648b236dd7e742ad41e42f',
    policy: 'tenant-content-history-entity-lock',
  },
  {
    file: 'packages/db/src/helpers/content-version-context.ts',
    method: '$queryRaw',
    hash: '49ae29957c480c5f3f70af0ea124cb2e022f59d89cbd4c70143979129e2a0812',
    policy: 'tenant-content-history-entity-lock',
  },
  {
    file: 'packages/db/src/helpers/content-version-context.ts',
    method: '$queryRaw',
    hash: '2e827b7734fc4c676c8316a0e7a5eda20c940d74f63b1d3cb41ed1e006ed4edf',
    policy: 'tenant-content-history-entity-lock',
  },
  {
    file: 'packages/db/src/helpers/embedding-claim-repair.ts',
    method: '$queryRaw',
    hash: 'ced88be1d97236cb5813ebb32caacb3b4939f20a4ab0368835f9846ac019c635',
    policy: 'tenant-venue-exact-invariant-repair',
  },
  {
    file: 'packages/db/src/helpers/embedding-claim-repair.ts',
    method: '$queryRaw',
    hash: '3e0a4da968b3cefbecee1942ee0fcdde47a2e8242bcf62e441db3fd29fde315c',
    policy: 'tenant-venue-exact-invariant-repair',
  },
  {
    file: 'packages/db/src/helpers/embedding-claim-repair.ts',
    method: '$queryRaw',
    hash: '68e27cda94ba3c6e1c7007b6dbb4f47ba0eaa3fe543ee1dbc6fb8fff4efa0a39',
    policy: 'tenant-venue-exact-invariant-repair',
  },
  {
    file: 'packages/db/src/helpers/embedding-claim-repair.ts',
    method: '$queryRaw',
    hash: '09469ab3b7115c4b6390e19b5386407bf48491670664129ef00a87600f68d254',
    policy: 'tenant-venue-exact-invariant-repair',
  },
  {
    file: 'packages/db/src/helpers/embedding-claim-repair.ts',
    method: '$queryRaw',
    hash: 'e299e9f7bab197669aa91d392996a7936d507317d7b6a0a0303e5610bbd75bda',
    policy: 'tenant-venue-exact-invariant-repair',
  },
  {
    file: 'packages/db/src/helpers/embedding-claim-repair.ts',
    method: '$queryRaw',
    hash: 'd2c558ce20afed52b4b8c3935b1a940e982f6885451c898a91a09dcc33f1100b',
    policy: 'tenant-venue-exact-invariant-repair',
  },
  {
    file: 'packages/db/src/helpers/embedding-claim-repair.ts',
    method: '$executeRaw',
    hash: '0ab4f9519b6ea989e9401086deb53e137ddc377ca51b3280a812a3062ddbd63a',
    policy: 'tenant-venue-exact-invariant-repair',
  },
  {
    file: 'packages/db/src/helpers/health.ts',
    method: '$executeRaw',
    hash: '97e65da8188e2a7988bd7afe8ac2091a6fa8552d036cf92031bcd6a28dbc96a1',
    policy: 'system-probe',
  },
  {
    file: 'packages/db/src/helpers/health.ts',
    method: '$queryRaw',
    hash: '1730fc082ddaf286020215008c78754a2d980d4e7aefc39e339c6684fca76e7c',
    policy: 'system-probe',
  },
  {
    file: 'apps/web/app/[venueSlug]/chat/layout.tsx',
    method: '$queryRaw',
    hash: '18364e754072766ce9704c6ca743a1774c58cfb786ff322c33e8367af6ed7b71',
    policy: 'public-venue-slug',
  },
  {
    file: 'packages/api/src/routers/analytics.ts',
    method: '$queryRaw',
    hash: '46303d6622b41aff5fc44f7d2d9201ba9b6cfada52486596296c0ce5784a8056',
    policy: 'public-venue-id',
  },
  {
    file: 'packages/api/src/routers/chat.ts',
    method: '$queryRaw',
    hash: 'b60eb08da4af4b7e56c4a5b111d614deaf0ebeb5cd9dcff1370ea3fd45f89b51',
    policy: 'public-venue-id',
  },
  {
    file: 'packages/api/src/routers/chat.ts',
    method: '$queryRaw',
    hash: '0d9343cf04e14fbb149568d40d9114ac091c144db25082ea4bffbff0ff4f4671',
    policy: 'public-venue-id',
  },
  {
    file: 'packages/api/src/routers/chat.ts',
    method: '$queryRaw',
    hash: '0e9c67756aeb6f06c65fa2f2dcad466db1b4c646bb47c819a3b7b4dfdf6de68c',
    policy: 'public-venue-session-token',
  },
  {
    file: 'packages/api/src/routers/venue.ts',
    method: '$queryRaw',
    hash: 'cc9351d36f562c57799328ef56fdb130629486500e382306f134062c805cb255',
    policy: 'public-venue-slug',
  },
  {
    file: 'packages/api/src/routers/venue.ts',
    method: '$queryRaw',
    hash: 'f869aa4e6f5b7b4015b2462ed70877c7691212ed0325374357ab8144470833ab',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/embedding-dispatches.ts',
    method: '$queryRaw',
    hash: 'a925e18ada96c0708399943037bf1131d99e9debefa92a74b8300a24b84a4b93',
    policy: 'platform-dispatch-lease',
  },
  {
    file: 'packages/db/src/helpers/embedding-dispatches.ts',
    method: '$executeRaw',
    hash: '1b2d60ffbbfc05eeb54b73f5d5f3a29bf030f7b9b1786f1861f9fd66749c7660',
    policy: 'tenant-venue-revision-lease',
  },
  {
    file: 'apps/workers/src/lib/embedding-freshness.ts',
    method: '$queryRaw',
    hash: '5f63160357e15ccea6e9a0572be64daa8ede1ba29f6c061eb4e5651bc714297a',
    policy: 'tenant-optional-venue-cursor-audit',
  },
  {
    file: 'apps/workers/src/lib/embedding-freshness.ts',
    method: '$queryRaw',
    hash: 'ef7a4ce0b2e86b9128ffcd478352c60ffcc2e6ef4730e1b653de4f8ecf8be408',
    policy: 'tenant-optional-venue-cursor-audit',
  },
  {
    file: 'packages/db/src/helpers/embedding-freshness-canary.ts',
    method: '$executeRaw',
    hash: '1de2f3c55a4f758efa80db716662a1d3f72702c21dfb88c81ddd92fa159c5b77',
    policy: 'tenant-venue-revision-canary-insert',
  },
  {
    file: 'packages/db/src/helpers/embedding-freshness-canary.ts',
    method: '$executeRaw',
    hash: '38ffe9c2bb013165ca00df8197f324134f35bc57bd907a42f8868523bf6e2cd9',
    policy: 'tenant-venue-revision-canary-insert',
  },
  {
    file: 'packages/db/src/helpers/embedding-work-claims.ts',
    method: '$queryRaw',
    hash: '1f0ad38f8215a2f31f3be7ba79e0bc9a747393876618b5c753c9d1924b4e55fc',
    policy: 'tenant-venue-entity-lease',
  },
  {
    file: 'packages/db/src/helpers/generation-execution-claims.ts',
    method: '$executeRaw',
    hash: 'a917f2b20dda562ab47f4bf99199196840072890bafa9a9b837b1b7e1adfce12',
    policy: 'tenant-venue-range-generation-dispatch-consume',
  },
  {
    file: 'packages/db/src/helpers/generation-recovery.ts',
    method: '$queryRaw',
    hash: 'd8d5dc88ee097448c22246158d2595357932f583c571d91aa9224244249827ed',
    policy: 'platform-expired-generation-discovery',
  },
  {
    file: 'packages/db/src/helpers/generation-recovery.ts',
    method: '$queryRaw',
    hash: '1d2474f8b0dc709ce3b1f040861aeeaf734d61955bb842dbb9a4098389167d41',
    policy: 'platform-expired-generation-discovery',
  },
  {
    file: 'packages/db/src/helpers/generation-execution-claims.ts',
    method: '$executeRaw',
    hash: 'd3259ba2ce1e08660a5dc30e7378baf9cde5ad7e18608b72dbff42b5134efe82',
    policy: 'tenant-venue-range-generation-dispatch-consume',
  },
  {
    file: 'packages/db/src/helpers/generation-execution-claims.ts',
    method: '$executeRaw',
    hash: '47e430bcf4bf1b655a8a6aafc6d54833eaede4cdd668cf39545174f4b25250a5',
    policy: 'tenant-venue-range-generation-lease',
  },
  {
    file: 'packages/db/src/helpers/generation-execution-claims.ts',
    method: '$executeRaw',
    hash: '58e08dbc39ff44dea12c780ca1cba56b147b66ff3513c0b4dac0a7d5131ae14b',
    policy: 'tenant-venue-range-generation-lease',
  },
  {
    file: 'packages/db/src/helpers/generation-execution-claims.ts',
    method: '$executeRaw',
    hash: '0b2f760a819682255c607d3aa91ce2cb6d055f9df34428938ac7455bcaefea6a',
    policy: 'tenant-venue-range-generation-lease',
  },
  {
    file: 'packages/db/src/helpers/generation-execution-claims.ts',
    method: '$executeRaw',
    hash: '91634428c12337305db6f1e811f7436acb0b8d25f7f90bd2b82c11ede96049eb',
    policy: 'tenant-venue-range-generation-lease',
  },
  {
    file: 'packages/db/src/helpers/generation-request-dispatches.ts',
    method: '$queryRaw',
    hash: '6b23c58927c22c4cfe1b81a9be4fa1376d3a9a9be2b0204c13492f44e526c071',
    policy: 'platform-generation-dispatch-lease',
  },
  ...[
    '6bb900882644e8bf41e1cc7f23ca66f52c2846caa7b820013bc76aee22d59bad',
    '73c658b1642ca6816f76e7d96ce26710da19709e7357faec1e301044905a9d2d',
    '71af5dd181a87025efa2d1f47a96afd053926d5cfd798317c56a1c678220aac2',
    'a10b854673a1e54550ab850c8890963a38ad1b3949e0c72d2641946546650ff8',
    'e41a8be47a563338f25f7030cab02bae22ecf6b5e70bc86b498b1a149698a603',
    'e9750a92b9237076ced2fb1732875f9da4ba80c84f301804114b5ac16d705e24',
    'f405fd6f8d927d39541e5e820ea14f124b83d80a584fcbdf5f6bc2923498a432',
  ].map((hash) => ({
    file: 'packages/db/src/helpers/generation-request-dispatches.ts',
    method: '$executeRaw',
    hash,
    policy: 'tenant-venue-record-generation-dispatch-lease',
  })),
  {
    file: 'packages/db/src/helpers/semantic-search.ts',
    method: '$queryRaw',
    hash: '078f87ab5b3961b369533d7182e91722f3aa9d45db444748597842670d2bc1f3',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/semantic-search.ts',
    method: '$executeRaw',
    hash: 'fa8acf3d6b5e28dfa8611f61c4c80432d6e87b1fd62a33410fee2d2a45931fdf',
    policy: 'tenant-venue-entity-lease',
  },
  {
    file: 'packages/db/src/helpers/semantic-search.ts',
    method: '$executeRaw',
    hash: 'a074100896e870e6222c82cc1777a4e5682cb63e58de6601f6e1e1041d3851e8',
    policy: 'tenant-venue-revision-source',
  },
  {
    file: 'packages/db/src/helpers/semantic-search.ts',
    method: '$queryRaw',
    hash: '86c45e1fb58daaf4ee5320549fa21008b76f1984fb96c010fde2f3442bfa510c',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/semantic-search.ts',
    method: '$executeRaw',
    hash: '62067bac1ff9fc9bdb241f6d57cc1087edcdd7b8b7b981684fd767c158f0b2a3',
    policy: 'tenant-venue-revision-source',
  },
]

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectFiles(absolute)))
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(absolute)
  }
  return files
}

function relativePath(absolute) {
  return path.relative(repositoryRoot, absolute).split(path.sep).join('/')
}

function isTestPath(fileName) {
  return /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(fileName)
}

function canonicalSql(sql) {
  // Preserve all semantic text, including whitespace inside literals/comments.
  return sql.replace(/\r\n?/g, '\n')
}

function canonicalExpression(expression, sourceFile) {
  return expression.getText(sourceFile).replace(/\r\n?/g, '\n')
}

function operationForTag(node, method, sourceFile, fileName) {
  let sql = ts.isNoSubstitutionTemplateLiteral(node.template)
    ? node.template.text
    : node.template.head.text
  const expressions = []
  if (ts.isTemplateExpression(node.template)) {
    for (const span of node.template.templateSpans) {
      expressions.push(canonicalExpression(span.expression, sourceFile))
      sql += ` $${expressions.length} ${span.literal.text}`
    }
  }
  const canonical = canonicalSql(sql)
  const signatureInput = `${method}\0${canonical}\0${expressions.join('\0')}`
  return {
    file: fileName,
    method,
    hash: createHash('sha256').update(signatureInput).digest('hex'),
    bindings: expressions,
    sql: canonical,
  }
}

function unwrapExpression(node) {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function constantString(node) {
  const current = unwrapExpression(node)
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return current.text
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantString(current.left)
    const right = constantString(current.right)
    return left === null || right === null ? null : left + right
  }
  return null
}

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node)) return constantString(node.argumentExpression)
  return null
}

function isDbReceiver(node, aliases) {
  const current = unwrapExpression(node)
  if (ts.isIdentifier(current)) return current.text === 'db' || aliases.has(current.text)
  return ts.isPropertyAccessExpression(current) && current.name.text === 'db'
}

function collectDbAliases(sourceFile) {
  const aliases = new Set()
  const declarations = []
  const collect = (node) => {
    if (ts.isVariableDeclaration(node)) declarations.push(node)
    ts.forEachChild(node, collect)
  }
  collect(sourceFile)

  let changed = true
  while (changed) {
    changed = false
    for (const declaration of declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        isDbReceiver(declaration.initializer, aliases) &&
        !aliases.has(declaration.name.text)
      ) {
        aliases.add(declaration.name.text)
        changed = true
      }
      if (ts.isObjectBindingPattern(declaration.name)) {
        for (const element of declaration.name.elements) {
          const sourceName =
            element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile)
          if (
            sourceName === 'db' &&
            ts.isIdentifier(element.name) &&
            !aliases.has(element.name.text)
          ) {
            aliases.add(element.name.text)
            changed = true
          }
        }
      }
    }
  }
  return aliases
}

function analyzeSource(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const operations = []
  const violations = []
  const dbAliases = collectDbAliases(sourceFile)

  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === 'Prisma') {
      violations.push(`${fileName}: Prisma namespace access is prohibited in production source`)
    }

    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const specifier = node.arguments[0]
      if (
        (isDynamicImport || isRequire) &&
        specifier &&
        constantString(specifier) === '@prisma/client'
      ) {
        violations.push(`${fileName}: dynamic Prisma client access is prohibited`)
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'Reflect' &&
        node.expression.name.text === 'get' &&
        node.arguments[0] &&
        isDbReceiver(node.arguments[0], dbAliases)
      ) {
        violations.push(`${fileName}: reflected database method access is prohibited`)
      }
    }

    const name = propertyName(node)
    if (name && rawMethods.has(name)) {
      if (ts.isElementAccessExpression(node)) {
        violations.push(`${fileName}: computed raw SQL reference ${name} is prohibited`)
      } else if (prohibitedMethods.has(name)) {
        violations.push(`${fileName}: Prisma raw method ${name} is prohibited`)
      } else if (!(ts.isTaggedTemplateExpression(node.parent) && node.parent.tag === node)) {
        violations.push(`${fileName}: ${name} must be used only as a direct tagged template`)
      } else {
        operations.push(operationForTag(node.parent, name, sourceFile, fileName))
      }
    }

    if (
      ts.isElementAccessExpression(node) &&
      ts.isTaggedTemplateExpression(node.parent) &&
      node.parent.tag === node &&
      name === null
    ) {
      violations.push(`${fileName}: computed tagged-template access is prohibited`)
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isCallExpression(node.parent) &&
      node.parent.expression === node
    ) {
      violations.push(`${fileName}: computed method calls are prohibited in production source`)
    }
    if (
      ts.isElementAccessExpression(node) &&
      name === null &&
      isDbReceiver(node.expression, dbAliases)
    ) {
      violations.push(`${fileName}: dynamic database method access is prohibited`)
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Prisma' &&
      prismaFragmentHelpers.has(node.name.text)
    ) {
      violations.push(`${fileName}: Prisma.${node.name.text} raw SQL fragments are prohibited`)
    }

    if (
      ts.isIdentifier(node) &&
      rawMethods.has(node.text) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      violations.push(`${fileName}: detached raw SQL reference ${node.text} is prohibited`)
    }

    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      rawMethods.has(node.text) &&
      !(ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node)
    ) {
      violations.push(`${fileName}: computed raw SQL reference ${node.text} is prohibited`)
    }

    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { operations, violations }
}

function operationKey(operation) {
  return `${operation.file}\0${operation.method}\0${operation.hash}`
}

function auditInventory(files, approved) {
  const violations = []
  const operations = []
  const approvedKeys = new Set()

  for (const entry of approved) {
    const key = operationKey(entry)
    if (approvedKeys.has(key)) violations.push(`duplicate raw SQL allowlist entry: ${key}`)
    approvedKeys.add(key)
    if (!approvedPolicies.has(entry.policy)) {
      violations.push(`${entry.file}: invalid or missing raw SQL policy '${entry.policy}'`)
    }
  }

  for (const { fileName, source } of files) {
    if (isTestPath(fileName)) continue
    const result = analyzeSource(source, fileName)
    operations.push(...result.operations)
    violations.push(...result.violations)
  }

  const observedKeys = new Set()
  for (const operation of operations) {
    const key = operationKey(operation)
    if (observedKeys.has(key)) {
      violations.push(`${operation.file}: duplicate raw SQL operation signature ${operation.hash}`)
    }
    observedKeys.add(key)
    if (!approvedKeys.has(key)) {
      violations.push(
        `${operation.file}: unapproved ${operation.method} signature ${operation.hash}`,
      )
    }
  }
  for (const entry of approved) {
    if (!observedKeys.has(operationKey(entry))) {
      violations.push(`${entry.file}: stale ${entry.method} signature ${entry.hash}`)
    }
  }

  return { operations, violations }
}

function expectFixtureFailure(name, files, approved, fragment) {
  const result = auditInventory(files, approved)
  if (!result.violations.some((violation) => violation.includes(fragment))) {
    throw new Error(`Raw SQL verifier failed its ${name} self-test`)
  }
}

function runSelfTests() {
  const fileName = 'packages/api/src/fixture.ts'
  const source = 'const rows = db.$queryRaw`SELECT id FROM places WHERE tenant_id = ${tenantId}`'
  const analyzed = analyzeSource(source, fileName)
  if (analyzed.violations.length > 0 || analyzed.operations.length !== 1) {
    throw new Error('Raw SQL verifier failed its clean parser self-test')
  }
  const approved = [{ ...analyzed.operations[0], policy: 'tenant-and-venue' }]
  if (auditInventory([{ fileName, source }], approved).violations.length > 0) {
    throw new Error('Raw SQL verifier failed its clean inventory self-test')
  }

  const literalWhitespaceA = analyzeSource(
    "const rows = db.$queryRaw`SELECT 'a b' WHERE tenant_id = ${tenantId}`",
    fileName,
  ).operations[0]
  const literalWhitespaceB = analyzeSource(
    "const rows = db.$queryRaw`SELECT 'a  b' WHERE tenant_id = ${tenantId}`",
    fileName,
  ).operations[0]
  if (!literalWhitespaceA || literalWhitespaceA.hash === literalWhitespaceB?.hash) {
    throw new Error('Raw SQL verifier failed its literal-whitespace collision self-test')
  }
  expectFixtureFailure(
    'semantic drift',
    [{ fileName, source: source.replace('tenant_id', 'venue_id') }],
    approved,
    'unapproved',
  )
  expectFixtureFailure(
    'binding drift',
    [{ fileName, source: source.replace('${tenantId}', '${venueId}') }],
    approved,
    'unapproved',
  )
  expectFixtureFailure(
    'unsafe method',
    [{ fileName, source: 'db.$queryRawUnsafe("SELECT 1")' }],
    [],
    'Prisma raw method $queryRawUnsafe is prohibited',
  )
  expectFixtureFailure(
    'function call',
    [{ fileName, source: 'db.$queryRaw("SELECT 1")' }],
    [],
    'direct tagged template',
  )
  expectFixtureFailure(
    'detached alias',
    [{ fileName, source: 'const { $queryRaw } = db; $queryRaw`SELECT 1`' }],
    [],
    'detached raw SQL reference',
  )
  expectFixtureFailure(
    'element access',
    [{ fileName, source: 'db["$queryRaw"]`SELECT 1`' }],
    [],
    'computed raw SQL reference',
  )
  expectFixtureFailure(
    'computed concatenation',
    [{ fileName, source: "db['$query' + 'Raw']`SELECT 1`" }],
    [],
    'computed raw SQL reference',
  )
  expectFixtureFailure(
    'dynamic computed tag',
    [{ fileName, source: 'const method = getMethod(); db[method]`SELECT 1`' }],
    [],
    'computed tagged-template access',
  )
  expectFixtureFailure(
    'dynamic database method',
    [{ fileName, source: 'const client = db; const method = getMethod(); client[method](query)' }],
    [],
    'dynamic database method access',
  )
  expectFixtureFailure(
    'wrapped dynamic method',
    [
      {
        fileName,
        source: 'const holder = { client: db }; holder.client[getMethod()](query)',
      },
    ],
    [],
    'computed method calls are prohibited',
  )
  expectFixtureFailure(
    'reflected database method',
    [{ fileName, source: 'Reflect.get(db, method)(query)' }],
    [],
    'reflected database method access',
  )
  expectFixtureFailure(
    'typed raw',
    [{ fileName, source: 'db.$queryRawTyped(query)' }],
    [],
    'Prisma raw method $queryRawTyped is prohibited',
  )
  expectFixtureFailure(
    'Prisma fragment',
    [{ fileName, source: 'const fragment = Prisma.sql`tenant_id = ${tenantId}`' }],
    [],
    'raw SQL fragments are prohibited',
  )
  expectFixtureFailure(
    'Prisma alias',
    [
      {
        fileName,
        source: "import { Prisma as P } from '@prisma/client'; P.sql`SELECT 1`",
      },
    ],
    [],
    'Prisma namespace access is prohibited',
  )
  expectFixtureFailure(
    'dynamic Prisma access',
    [{ fileName, source: "const p = await import('@prisma/client')" }],
    [],
    'dynamic Prisma client access is prohibited',
  )
  expectFixtureFailure('stale allowlist', [], approved, 'stale')
  expectFixtureFailure(
    'duplicate allowlist',
    [{ fileName, source }],
    [...approved, ...approved],
    'duplicate raw SQL allowlist entry',
  )
}

runSelfTests()

const sourceFiles = (
  await Promise.all(
    ['apps', 'packages'].map((directory) => collectFiles(path.join(repositoryRoot, directory))),
  )
).flat()
const files = await Promise.all(
  sourceFiles.map(async (absolute) => ({
    fileName: relativePath(absolute),
    source: await readFile(absolute, 'utf8'),
  })),
)
const result = auditInventory(files, approvedOperations)

if (process.argv.includes('--print-inventory')) {
  console.log(JSON.stringify(result.operations, null, 2))
  if (result.violations.length > 0) {
    console.error('Raw SQL boundary violations:')
    for (const violation of [...new Set(result.violations)].sort()) console.error(`- ${violation}`)
    process.exit(1)
  }
  process.exit(0)
}

if (result.violations.length > 0) {
  console.error('Raw SQL boundary violations:')
  for (const violation of [...new Set(result.violations)].sort()) console.error(`- ${violation}`)
  process.exit(1)
}

const reads = result.operations.filter((operation) => operation.method === '$queryRaw').length
const writes = result.operations.length - reads
console.log(
  `Verified ${result.operations.length} raw SQL operations: ${reads} reads, ${writes} writes.`,
)
