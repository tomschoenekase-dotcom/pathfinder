const REQUIRED_PROTECTED_RULES = ['**/.env', '**/.env.*', '**/*.env', '**/*.env.*', '**/.claude/']

export class DockerContextBoundaryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DockerContextBoundaryError'
  }
}

export function verifyDockerContextBoundary(contents) {
  const rules = contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  const ruleSet = new Set(rules)
  const missing = REQUIRED_PROTECTED_RULES.filter((rule) => !ruleSet.has(rule))

  if (missing.length > 0) {
    throw new DockerContextBoundaryError(
      `Docker context boundary is missing ${missing.length} required protected-path rule(s).`,
    )
  }

  // Docker applies the last matching rule. A broad later re-inclusion can
  // override a protected path without naming that path itself.
  if (rules.some((rule) => rule.startsWith('!'))) {
    throw new DockerContextBoundaryError(
      'Docker context boundary must not use re-inclusion rules while protected paths are enforced.',
    )
  }

  return { protectedRuleCount: REQUIRED_PROTECTED_RULES.length }
}

export function verifyDockerfileContextGuard(contents) {
  const copyIndex = contents.indexOf('COPY . .')
  const installIndex = contents.indexOf('RUN pnpm install --frozen-lockfile')
  const envGuardIndex = contents.indexOf("find . -type f \\( -name '.env'", copyIndex)
  const agentGuardIndex = contents.indexOf("find . -type d -name '.claude'", copyIndex)

  if (
    copyIndex < 0 ||
    installIndex < 0 ||
    envGuardIndex <= copyIndex ||
    agentGuardIndex <= copyIndex ||
    envGuardIndex >= installIndex ||
    agentGuardIndex >= installIndex
  ) {
    throw new DockerContextBoundaryError(
      'Worker Dockerfile must verify protected paths immediately after source copy and before install.',
    )
  }

  return { guardedBeforeInstall: true }
}

export function verifyDockerIgnoreInventory(relativePaths) {
  const alternates = relativePaths.filter(
    (relativePath) => relativePath.replaceAll('\\', '/') !== '.dockerignore',
  )
  if (alternates.length > 0) {
    throw new DockerContextBoundaryError(
      'Docker context boundary forbids alternate ignore files that can override the root policy.',
    )
  }

  return { ignoreFileCount: relativePaths.length }
}
